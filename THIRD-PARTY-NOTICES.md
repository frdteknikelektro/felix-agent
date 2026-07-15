# Third-party notices

Felix is distributed under Apache-2.0. The image and source distribution also include third-party software under their own licenses.

The exact transitive dependency set is recorded in `package-lock.json` and `web/package-lock.json`; those lockfiles are the authoritative version and integrity manifest. License fields for every resolved npm package are present in the lockfiles. The following tables list the direct dependencies shipped or used to build Felix.

## Runtime and server dependencies

| Package | Resolved version | License |
| --- | --- | --- |
| `@anthropic-ai/claude-code` | 2.1.185 | See package README/license |
| `@aws-sdk/client-dynamodb` | 3.1080.0 | Apache-2.0 |
| `@azure/cosmos` | 4.9.3 | MIT |
| `@openai/codex` | 0.133.0 | Apache-2.0 |
| `@slack/bolt` | 4.7.3 | MIT |
| `discord.js` | 14.26.4 | Apache-2.0 |
| `docx` | 9.7.1 | MIT |
| `ioredis` | 5.11.1 | MIT |
| `mongodb` | 6.21.0 | Apache-2.0 |
| `mysql2` | 3.22.6 | MIT |
| `opencode-ai` | 1.17.3 | MIT |
| `pg` | 8.22.0 | MIT |
| `pptxgenjs` | 4.0.1 | MIT |
| `ws` | 8.21.0 | MIT |
| `yaml` | 2.9.0 | ISC |
| `zod` | 3.25.76 | MIT |

## Owner console build dependencies

| Package | Resolved version | License |
| --- | --- | --- |
| `react` / `react-dom` | 18.3.1 | MIT |
| `react-router-dom` | 6.30.4 | MIT |
| `lucide-react` | 0.460.0 | ISC |
| `@tailwindcss/vite` / `tailwindcss` | 4.3.1 | MIT |
| `@vitejs/plugin-react` | 4.7.0 | MIT |
| `vite` | 7.3.6 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |

## Runtime binaries and system packages

The Docker image also installs Debian packages and upstream binaries for `wacli`, `whisper.cpp`, and Piper. Their source project licenses and release versions are maintained in [Dockerfile](./Dockerfile); redistribution remains subject to each upstream license. Customers redistributing the image should retain this notice and inspect the upstream notices for the exact image build they distribute.
