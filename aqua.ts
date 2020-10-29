import { serve, serveTLS, Server, ServerRequest, Response as ServerResponse } from "https://deno.land/std@0.75.0/http/server.ts";
import Router from "./router.ts";
import ContentHandler from "./content_handler.ts";

type ResponseHandler = (req: Request) => (RawResponse | Promise<RawResponse>);
type Method = "GET" | "HEAD" | "POST" | "PUT" | "DELETE" | "CONNECT" | "OPTIONS" | "TRACE" | "PATCH";
type Middleware = (req: Request, res: Response) => Response;
type RawResponse = string | Response;
export type Response = ContentResponse | RedirectResponse;

interface ServerRequestWithRawRespond extends ServerRequest {
    rawRespond: (res: ServerResponse) => Promise<void>;
}

interface ContentResponse {
    statusCode?: number;
    headers?: { [name: string]: string; };
    cookies?: { [name: string]: string; };
    redirect?: string;
    content: string;
}

interface RedirectResponse {
    statusCode?: number;
    headers?: { [name: string]: string; };
    cookies?: { [name: string]: string; };
    redirect: string;
    content?: string;
}

export interface Request {
    raw: ServerRequest;
    url: string;
    method: Method;
    headers: Headers;
    query: { [name: string]: string; };
    body: { [name: string]: string; };
    cookies: { [name: string]: string; };
    parameters: { [name: string]: string; };
    matches: string[];
}

export interface Route {
    path: string;
    usesURLParameters: boolean;
    urlParameterRegex?: RegExp;
    responseHandler: ResponseHandler;
}

export interface RegexRoute {
    path: RegExp;
    responseHandler: ResponseHandler;
}

export interface StaticRoute {
    folder: string;
    path: string;
}

export interface Options {
    ignoreTrailingSlash?: boolean;
    log?: boolean;
    tls?: {
        independentPort?: number;
        hostname?: string;
        certFile: string;
        keyFile: string;
    }
}

export default class Aqua {
    private readonly textDecoder: TextDecoder;
    private readonly servers: Server[] = [];
    private routes: { [path: string]: Route } = {};
    private regexRoutes: RegexRoute[] = [];
    private options: Options = {};
    private middlewares: Middleware[] = [];
    private staticRoutes: StaticRoute[] = [];

    private fallbackHandler: ResponseHandler | null = null;

    constructor(port: number, options?: Options) {
        const onlyTLS = (options?.tls && !options.tls.independentPort) || options?.tls?.independentPort === port;

        if (options?.tls) {
            this.servers.push(serveTLS({
                hostname: options.tls.hostname || "localhost",
                certFile: options.tls.certFile || "./localhost.crt",
                keyFile: options.tls.keyFile || "./localhost.key",
                port: options.tls.independentPort || port
            }));
        }

        if (!onlyTLS) this.servers.push(serve({ port }));

        this.textDecoder = new TextDecoder();
        this.options = options || {};
        this.spinUpServers();
        if (this.options.log) console.log(`Server started (http://localhost:${port})`);
    }

    public async render(filePath: string): Promise<string> {
        try {
            return this.textDecoder.decode(await Deno.readFile(filePath));
        }catch {
            return "Could not render file.";
        }
    }

    private async parseBody(req: ServerRequest): Promise<{ [name: string]: string; }> {
        if (!req.contentLength) return {};

        const buffer: Uint8Array = new Uint8Array(req.contentLength || 0);
        const lengthRead: number = await req.body.read(buffer) || 0;
        const rawBody: string = this.textDecoder.decode(buffer.subarray(0, lengthRead));
        let body: {} = {};

        if (!rawBody) return {};

        try {
            body = JSON.parse(rawBody);
        }catch(error) {
            if (rawBody.includes(`name="`)) {
                body = (rawBody.match(/name="(.*?)"(\s|\n|\r)*(.*)(\s|\n|\r)*---/gm) || [])
                    .reduce((fields: {}, field: string): {} => {
                        if (!/name="(.*?)"/.exec(field)?.[1]) return fields;

                        return {
                            ...fields,
                            [/name="(.*?)"/.exec(field)?.[1] || ""]: field.match(/(.*?)(?=(\s|\n|\r)*---)/)?.[0]
                        }
                    }, {});
            }
        }

        return body;
    }

    private parseQuery(req: ServerRequest): { [name: string]: string; } {
        if (!req.url.includes("?")) return {};

        const queryString: string[] = req.url.replace(/(.*)\?/, "").split("&");

        return queryString.reduce((queries: {}, query: string): {} => {
            if (!query || !query.split("=")?.[0] || query.split("=")?.[1] === undefined) return queries;

            return {
                ...queries,
                [decodeURIComponent(query.split("=")?.[0])]: decodeURIComponent(query.split("=")?.[1].replace(/\+/g, " "))
            }
        }, {}) || {};
    }

    private parseCookies(req: ServerRequest): { [name: string]: string; } {
        const rawCookieString: string | null = req.headers.get("cookie");

        if (!rawCookieString) return {};

        return rawCookieString.split(";").reduce((cookies: {}, cookie: string): {} => {
            return {
                ...cookies,
                [cookie.split("=")[0].trimLeft()]: cookie.split("=")[1]
            };
        }, {});
    }

    private connectURLParameters(route: Route, requestedPath: string): { [name: string]: string; } {
        return route.path.match(/:([a-zA-Z0-9_]*)/g)?.reduce((storage: { urlParameters: any; currentRequestedPath: string; }, urlParameterWithColon: string) => {
            const urlParameter = urlParameterWithColon.replace(":", "");
            const partTillParameter = route.path.split(urlParameterWithColon)[0];
            const urlParameterValue = storage.currentRequestedPath.replace(
                new RegExp(partTillParameter.replace(/:([a-zA-Z0-9_]*)/, ".*?")),
                ""
            ).match(/([^\/]*)/g)?.[0];
            const currentRequestedPath = storage.currentRequestedPath.replace(/:([a-zA-Z0-9_]*)/, "");

            return {
                urlParameters: {
                    ...storage.urlParameters,
                    [urlParameter]: urlParameterValue
                },
                currentRequestedPath
            };
        }, { urlParameters: {}, currentRequestedPath: requestedPath }).urlParameters;
    }

    private formatRawResponse(rawResponse: RawResponse): Response {
        return typeof rawResponse === "string" ? { content: rawResponse } : rawResponse;
    }

    private isRegexRoute(route: Route | RegexRoute): boolean {
        return route.path instanceof RegExp;
    }

    private async respondToRequest(req: Request, requestedPath: string, route: Route | RegexRoute, usesURLParameters: boolean = false) {
        if (usesURLParameters) {
            req.parameters = this.connectURLParameters(route as Route, requestedPath);

            if (Object.values(req.parameters).find((parameterValue) => parameterValue === "") !== undefined) {
                await this.respondWithNoRouteFound(req);
                return;
            }
        }

        if (this.isRegexRoute(route)) req.matches = (requestedPath.match(route.path) as string[]).slice(1) || [];

        const formattedResponse: Response = this.formatRawResponse(await route.responseHandler(req));

        if (!formattedResponse) {
            req.raw.respond({ body: "No response content provided." });
            return;
        }

        const responseAfterMiddlewares: Response = this.middlewares.length > 0 ? this.middlewares.reduce((currentResponse: Response, middleware: Middleware): Response => {
            if (!currentResponse) return currentResponse;

            return middleware(req, currentResponse);
        }, formattedResponse) : formattedResponse;
        const headers: Headers = new Headers(formattedResponse.headers || {});

        if (formattedResponse.cookies) {
            for (const cookieName of Object.keys(formattedResponse.cookies))
                headers.append("Set-Cookie", `${cookieName}=${formattedResponse.cookies[cookieName]}`);
        }

        if (formattedResponse.redirect) {
            headers.append("Location", formattedResponse.redirect);
            responseAfterMiddlewares.statusCode = responseAfterMiddlewares.statusCode || 301;
        }

        req.raw.respond({
            headers,
            status: responseAfterMiddlewares.statusCode,
            body: responseAfterMiddlewares.content || "No response content provided."
        });
    }

    private async respondWithNoRouteFound(req: Request): Promise<void> {
        if (this.fallbackHandler) {
            const fallbackResponse: Response = this.formatRawResponse(await this.fallbackHandler(req));

            if (!fallbackResponse) {
                req.raw.respond({ status: 404, body: "No registered route found." });
                return;
            }

            fallbackResponse.statusCode = fallbackResponse.redirect
                ? fallbackResponse.statusCode || 301
                : fallbackResponse.statusCode || 404;
            const headers: Headers = new Headers(fallbackResponse.headers || {});

            if (fallbackResponse.cookies) {
                for (const cookieName of Object.keys(fallbackResponse.cookies))
                    headers.append("Set-Cookie", `${cookieName}=${fallbackResponse.cookies[cookieName]}`);
            }

            if (fallbackResponse.redirect)
                headers.append("Location", fallbackResponse.redirect);

            req.raw.respond({
                headers,
                status: fallbackResponse.statusCode,
                body: fallbackResponse.content || "No fallback response content provided."
            });
            return;
        }

        req.raw.respond({ status: 404, body: "No registered route found." });
    }

    private spinUpServers() {
        for (const server of this.servers) {
            this.handleRequests(server);
        }
    }

    private async respondToStaticRequest(req: Request, requestedPath: string, staticRoute: StaticRoute) {
        const resourcePath: string = requestedPath.replace(staticRoute.path, "");
        const extension: string = resourcePath.replace(/.*(?=\.[a-zA-Z0-9_]*$)/, "");
        const contentType: string | null = extension ? ContentHandler.getContentType(extension) : null;

        try {
            req.raw.respond({ headers: contentType ? new Headers({ "Content-Type": contentType }) : new Headers(), body: await Deno.readFile(staticRoute.folder + resourcePath) });
        }catch {
            req.raw.respond({ status: 404, body: "File not found" });
        }
    }

    private async handleRequests(server: Server) {
        for await (const rawRequest of server) {
            if (this.options.ignoreTrailingSlash) rawRequest.url = rawRequest.url.replace(/\/$/, "") + "/";

            const req: Request = {
                raw: rawRequest,
                url: rawRequest.url,
                headers: rawRequest.headers,
                method: (rawRequest.method.toUpperCase() as Method),
                query: rawRequest.url.includes("?") ? this.parseQuery(rawRequest) : {},
                body: rawRequest.contentLength ? await this.parseBody(rawRequest) : {},
                cookies: rawRequest.headers.get("cookies") ? this.parseCookies(rawRequest) : {},
                parameters: {},
                matches: []
            };
            const requestedPath = Router.parseRequestPath(req.url);

            if (this.options.log) {
                (req.raw as ServerRequestWithRawRespond).rawRespond = rawRequest.respond;
                req.raw.respond = async (res: ServerResponse) => {
                    console.log(`\x1b[33m${req.method}`, `\x1b[0m${requestedPath}`, `-> \x1b[36m${res.status || 200}\x1b[0m`);
                    await (req.raw as ServerRequestWithRawRespond).rawRespond(res);
                }
            }

            if (!this.routes[req.method + requestedPath]) {
                const matchingRouteWithURLParameters = Router.findRouteWithMatchingURLParameters(requestedPath, this.routes);

                if (matchingRouteWithURLParameters) {
                    await this.respondToRequest(req, requestedPath, matchingRouteWithURLParameters, true);
                    continue;
                }

                const matchingRegexRoute = Router.findMatchingRegexRoute(requestedPath, this.regexRoutes);

                if (matchingRegexRoute) {
                    await this.respondToRequest(req, requestedPath, matchingRegexRoute as RegexRoute);
                    continue;
                }

                if (req.method === "GET") {
                    const matchingStaticRoute = Router.findMatchingStaticRoute(requestedPath, this.staticRoutes);

                    if (matchingStaticRoute) {
                        await this.respondToStaticRequest(req, requestedPath, matchingStaticRoute);
                        continue;
                    }
                }

                await this.respondWithNoRouteFound(req);
            }else {
                await this.respondToRequest(req, requestedPath, this.routes[req.method + requestedPath]);
            }
        }
    }

    public provideFallback(responseHandler: ResponseHandler): Aqua {
        this.fallbackHandler = responseHandler;
        return this;
    }

    public register(middleware: Middleware): Aqua {
        this.middlewares.push(middleware);
        return this;
    }

    public route(path: string | RegExp, method: Method, responseHandler: ResponseHandler): Aqua {
        if (path instanceof RegExp) {
            this.regexRoutes.push({ path, responseHandler });
            return this;
        }

        if (!path.startsWith("/")) throw Error("Routes must start with a slash");
        if (this.options.ignoreTrailingSlash) path = path.replace(/\/$/, "") + "/";

        const usesURLParameters = /:[a-zA-Z]/.test(path);

        this.routes[method.toUpperCase() + path] = {
            path,
            usesURLParameters,
            urlParameterRegex: usesURLParameters ? new RegExp(path.replace(/:([a-zA-Z0-9_]*)/g, "([^\/]*)")) : undefined,
            responseHandler
        };
        return this;
    }

    public get(path: string | RegExp, responseHandler: ResponseHandler): Aqua {
        this.route(path, "GET", responseHandler);
        return this;
    }

    public post(path: string | RegExp, responseHandler: ResponseHandler): Aqua {
        this.route(path, "POST", responseHandler);
        return this;
    }

    public serve(folder: string, path: string) {
        if (!path.startsWith("/")) throw Error("Routes must start with a slash");
        this.staticRoutes.push({ folder: folder.replace(/\/$/, "") + "/", path: path.replace(/\/$/, "") + "/" });
    }
}
