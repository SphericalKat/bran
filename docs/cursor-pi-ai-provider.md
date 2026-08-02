# Cursor as a pi-ai provider

## Conclusion

`@earendil-works/pi-ai` does not currently include Cursor as a built-in provider. Cursor also does not document a raw model-inference endpoint with OpenAI, Anthropic, or equivalent message/tool-call semantics.

Cursor's public API is an **agent API**. It creates a durable Cursor agent and run, then streams events from Cursor's own agent loop. That is a different abstraction from a pi-ai provider, which supplies model responses to an agent loop owned by `pi-agent-core`.

There is, however, a third-party project called [`pi-cursor-sdk`](https://github.com/fitchmultz/pi-cursor-sdk) that registers Cursor under Pi's provider-shaped extension interface. It proves that Cursor can be made to appear as a provider in the Pi coding-agent UI. It does this by preserving and adapting Cursor's complete agent loop, not by exposing Cursor as a bare pi-ai inference provider.

For Bran, that distinction is decisive: the published package cannot run in Cloudflare Workers and is not a drop-in provider for the current `pi-agent-core` review loop. A Worker-native adaptation is possible through Cursor's REST API, but it would be an alternate Cursor review engine rather than the same Pi loop with a different model.

## What pi-ai supports

The pi-ai built-in provider catalog includes OpenAI, Anthropic, Google, GitHub Copilot, OpenRouter, Cloudflare AI Gateway, Workers AI, and other inference providers, but not Cursor. The generated provider registry likewise has no Cursor provider. [pi-ai supported providers and catalog](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#supported-providers), [pi-ai built-in registry](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/all.ts)

pi-ai does support custom providers through `createProvider()`. That facility expects a model catalog, authentication, and an API implementation. The documented reuse path is for OpenAI-compatible, Anthropic-compatible, proxy, or local inference endpoints. [pi-ai custom providers](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#custom-providers)

Bran could use that mechanism if Cursor exposed a compatible model endpoint. No such endpoint appears in Cursor's current official API documentation.

## What pi-cursor-sdk actually does

`pi-cursor-sdk` registers a provider named `cursor` through `pi.registerProvider()`, supplying a custom `streamSimple` implementation. That is the extension interface from `pi-coding-agent`, not a built-in provider exported by pi-ai and not a `createProvider()` registration that can simply be imported into Bran. [Provider registration](https://github.com/fitchmultz/pi-cursor-sdk/blob/ad37f2c633763e2d23b851cfc8fc1a68b8ed1757/src/index.ts)

Its stream adapter creates a pi `AssistantMessageEventStream`, then starts or resumes an `@cursor/sdk` agent and translates Cursor SDK events into Pi display and assistant events. It explicitly documents that Cursor's own agent loop remains intact. [Project design](https://github.com/fitchmultz/pi-cursor-sdk/blob/ad37f2c633763e2d23b851cfc8fc1a68b8ed1757/README.md), [stream adapter](https://github.com/fitchmultz/pi-cursor-sdk/blob/ad37f2c633763e2d23b851cfc8fc1a68b8ed1757/src/cursor-provider.ts), [Cursor turn runner](https://github.com/fitchmultz/pi-cursor-sdk/blob/ad37f2c633763e2d23b851cfc8fc1a68b8ed1757/src/cursor-provider-turn-runner.ts)

The adapter does not pass Pi's context and tools to a raw model endpoint. It serializes the Pi conversation, prior tool calls, and tool results into a text prompt for the Cursor agent. Cursor then chooses and executes tools from its own SDK/MCP surface. [Prompt conversion](https://github.com/fitchmultz/pi-cursor-sdk/blob/ad37f2c633763e2d23b851cfc8fc1a68b8ed1757/src/context.ts)

The project can expose Pi extension tools back to Cursor through a local MCP bridge, but that bridge starts a loopback Node HTTP server and integrates with Pi's extension lifecycle. It is not an in-process mapping from a pi-ai `Tool` to a Cursor tool call. [Pi tool bridge](https://github.com/fitchmultz/pi-cursor-sdk/blob/ad37f2c633763e2d23b851cfc8fc1a68b8ed1757/src/cursor-pi-tool-bridge.ts), [bridge server](https://github.com/fitchmultz/pi-cursor-sdk/blob/ad37f2c633763e2d23b851cfc8fc1a68b8ed1757/src/cursor-pi-tool-bridge-server.ts)

So the package is a legitimate Pi provider extension in the user-facing sense, while still being a nested agent adapter in architectural terms. Those statements are not contradictory.

### Cloudflare Workers compatibility

`pi-cursor-sdk` requires Node.js 22.19 or newer and depends on `@cursor/sdk`, `@hono/node-server`, and the MCP SDK. Its source uses Node child processes, filesystem APIs, HTTP servers, process signals, local git, loopback sockets, and platform-specific Cursor SDK binaries. [Package manifest](https://github.com/fitchmultz/pi-cursor-sdk/blob/ad37f2c633763e2d23b851cfc8fc1a68b8ed1757/package.json), [tool bridge](https://github.com/fitchmultz/pi-cursor-sdk/blob/ad37f2c633763e2d23b851cfc8fc1a68b8ed1757/src/cursor-pi-tool-bridge.ts), [cloud local-state inspection](https://github.com/fitchmultz/pi-cursor-sdk/blob/ad37f2c633763e2d23b851cfc8fc1a68b8ed1757/src/cursor-cloud-local-state.ts)

Those requirements are incompatible with the Cloudflare Worker runtime used by Bran. Enabling `nodejs_compat` does not provide working subprocesses, an inbound loopback listener, a persistent local workspace, or native platform binaries.

The reusable idea is the event translation, not the package itself. A Worker implementation would need to call Cursor's Cloud Agents REST endpoints with `fetch` and parse SSE directly.

## What Cursor exposes

Cursor exposes programmatic **agents** through its Cloud Agents API and TypeScript SDK:

- `POST /v1/agents` creates an agent and its initial run.
- `POST /v1/agents/{id}/runs` starts a follow-up run.
- `GET /v1/agents/{id}/runs/{runId}/stream` streams the run over SSE.
- `GET /v1/models` discovers models available to Cursor agents; it is not a model-completion endpoint.

The run stream includes assistant, tool-call, result, status, error, and completion events. Those tool calls are performed by Cursor's harness. They are not requests for Bran's `pi-agent-core` loop to execute. [Cursor Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints)

Cursor describes its SDK as access to the same runtime, harness, and models used by Cursor. Cloud sessions receive a dedicated VM, cloned repository, context management, search, MCP, skills, hooks, and subagents. This confirms that the product boundary is a complete coding-agent runtime rather than bare Composer or frontier-model inference. [Cursor SDK announcement](https://cursor.com/blog/typescript-sdk)

Cursor API requests use a Cursor user API key through Basic or Bearer authentication. The Cursor key is separate from Bran's GitHub OAuth token and repository authorization. [Cursor API overview](https://cursor.com/docs/api)

## What a compatibility adapter changes

A pi-ai provider must accept Pi's conversation context and tool schemas, stream model text and tool-call arguments back, and let `pi-agent-core` decide when and how to execute tools.

A Cursor Cloud Agent instead accepts a task and agent configuration, operates its own workspace, manages context, chooses and executes tools, and reports what its agent did. `pi-cursor-sdk` demonstrates that adapting this into Pi events can work as a product integration, but it still creates this ownership boundary:

```text
pi-agent-core
  -> fake Cursor model provider
    -> Cursor agent loop
      -> Cursor tools and workspace
```

This is acceptable when the goal is to preserve Cursor's agent behavior and make it feel native in Pi. It is not a transparent model substitution.

For Bran, it also bypasses the existing GitHub-backed `read_file`, `search_code`, `get_file_diff`, and `submit_review` tools. Cursor will not call those in-process Pi tools automatically. They would have to be exposed as a publicly reachable authenticated HTTP MCP server, or the Cursor runner would need a separate review protocol that returns validated JSON without using those tools.

## Viable options

### Keep the existing Pi review loop

Use a model provider that pi-ai already supports, or an actual OpenAI/Anthropic-compatible inference endpoint. This preserves Bran's current GitHub OAuth access, immutable PR-head reads, custom review tools, structured result validation, and Telegram progress events.

This is the lower-risk option and requires no architectural split.

### Add Cursor as an alternate review backend

Call the Cloud Agents REST API directly with `fetch`, consume its SSE stream, and translate Cursor run status into Telegram progress. This follows the same high-level event-adapter idea as `pi-cursor-sdk`, but uses the Worker-compatible REST boundary. Do not import `pi-cursor-sdk` or `@cursor/sdk` into the Worker: both are Node-first, while direct HTTP and SSE are compatible with the Worker runtime. [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript), [Cursor Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints)

This path would need separate decisions and implementation for:

- Cursor API-key storage and account ownership.
- Cursor repository access in addition to the reviewer's GitHub OAuth connection.
- Whether Cursor receives a repository/ref or uses remote HTTP MCP tools to read the PR.
- How Cursor's unstructured agent result becomes Bran's validated review schema.
- Cancellation, retries, SSE reconnection, and one-active-run conflicts.
- Whether Cursor may change repository state or must operate read-only.

This is an alternate engine, not a provider switch inside `src/reviewer/model.ts`.

## Recommendation

Do not build against an undocumented internal Cursor model endpoint, and do not install `pi-cursor-sdk` in the Worker.

If the goal is specifically to use Composer or Cursor billing, build a Worker-native `CursorReviewRunner` backed by the documented Cloud Agents REST API. It can present the same high-level review interface to `ReviewerAgent`, but Cursor—not `pi-agent-core`—will own that review run.

If the goal is merely to select another underlying LLM while preserving Bran's current tools and control flow, use one of pi-ai's supported inference providers and keep the current review architecture.
