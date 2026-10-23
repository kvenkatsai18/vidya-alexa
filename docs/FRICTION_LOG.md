# Friction log

What got in the way while building Vidya, and what would have helped.

| # | Task | Expected | Actual | Severity | Workaround | Suggestion |
|---|---|---|---|---|---|---|
| 1 | First Bedrock call on a new AWS account | The IAM user with Bedrock access can call Nova right away | `AccessDeniedException`: the account "is currently being verified… normally takes less than 2 hours". Polly worked at the same moment. | Medium | Waited; built against a fake Bedrock client meanwhile | Show the verification hold in the Bedrock console, not only as an API error |
| 2 | Turn on Nova Web Grounding | Works with existing Bedrock access | Needed `bedrock:InvokeTool` on the `amazon.nova_grounding` system-tool ARN | Medium | Added the permission by hand | Name the exact permission on the Web Grounding page and in the error |
| 3 | Live testing with a few parallel calls | Normal latency | `ThrottlingException: Too many requests` on a new account, failing turns | Medium | Adaptive retries (6 attempts) and a spoken "give me a few seconds" | Show new-account quotas up front in the console |
| 4 | Long voice conversations with Nova 2 Lite | Short spoken replies that use tools | After several turns it drifted into 100+ word answers with headings and skipped tools | Medium | A short reminder appended to every user turn | Guidance or a setting for voice-style output |
| 5 | Use the MCP Apps helpers with a 2025-11-25 server | Helpers work with the required spec | ext-apps 2.x requires SDK v2 and the 2026-07-28 spec | Medium | Implemented the MCP Apps wire protocol by hand | Publish a version compatibility table |
| 6 | Find a way to test on Alexa+ | A path to an Alexa+ simulator | Tooling is partner-only; only the FAQ says so | High | Built our own simulator that is an MCP client | A partner-only note on every setup page, and a public simulator |
| 7 | Size an MCP App iframe | The iframe fits its content | A `ResizeObserver` on `<html>` reports the viewport | Low | Observe `<body>` | Put the correct snippet in the docs |
| 8 | Record a smooth demo of a voice app | Screen recording in sync with the app | The browser's own recording drifted up to 12 seconds behind real time over a few minutes, so voices and screen went out of sync | Low | Flashed tiny sync markers during cut-out moments and lined everything up from them | Not an Amazon tool, but worth a tip in hackathon resources: record with OBS, or keep takes short |

## Feature requests

- **Critical:** a public Alexa+ simulator for self-hosted MCP servers, with MCP Apps support.
- **Important:** Nova output controls for voice (length, no markdown); IAM roles for Lightsail instances.
- **Nice to have:** a cheaper Polly tier for conversational apps; an "under 13" age range in Google's People API.
