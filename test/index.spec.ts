import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { AppEnv } from "../src/env";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("Fortagram worker", () => {
	it("responds with a health check (unit style)", async () => {
		const request = new IncomingRequest("http://example.com");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env as AppEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toBe("Fortagram is running");
	});

	it("responds with a health check (integration style)", async () => {
		const response = await SELF.fetch("https://example.com");
		expect(await response.text()).toBe("Fortagram is running");
	});
});
