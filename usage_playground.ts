// @todo delete this file

import { Aqua, Method } from "./mod.ts";

const app = new Aqua({
  listen: {
    port: 80,
  },
});

app.route("/").respond(Method.GET, (_event) => {
  return new Response("Hello, World!");
});

// /v1
const getUserByRequest = (_req: Request) => Promise.resolve({ name: "test" });

const v1 = app.route("/v1").step(async (event) => {
  if (!event.request.headers.has("X-Api-Key")) {
    event.response = Response.json(
      { error: "MISSING_API_KEY" },
      {
        status: 400,
      }
    );
    return event.end();
  }

  const user = await getUserByRequest(event.request);
  //    ^ type User

  return {
    ...event,
    user,
  };
});

v1.route("/user").respond(Method.GET, (event) => {
  return Response.json({ data: { user: event.user } });
  //                                         ^ type User
});

// /test
const test = app.route("/test").step((event) => {
  console.log("/test global step");
  return event;
});

test
  .route("/1")
  .step((e) => (console.log("/test/1 step"), e))
  .respond(Method.GET, () => new Response("GET"))
  .respond(Method.POST, () => new Response("POST"));
