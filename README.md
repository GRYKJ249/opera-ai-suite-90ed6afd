# Opera AI Suite

Create a complete, fully functional Opera AI ecosystem application.
It includes:
1. OperaDB Engine: Custom JSON/binary document collection database with Write-Ahead Logging (WAL) crash recovery, atomic temporary file writes, in-memory indexing, LRU write-through cache, read-write mutex locks, and rich CRUD query capabilities ($eq, $gt, $lt, $gte, $lte, $in, $regex, $set, $inc).
2. OperaCloud Storage Engine: Stream-based file ingestion with zero high-level dependencies, on-the-fly AES-256-GCM encryption at rest, HTTP Range-based streaming download, quota enforcement (default 1GB), and HMAC-signed pre-signed URL generator.
3. Opera AI Auth & RBAC: Custom native scrypt password hashing, native HMAC-SHA256 JWT generation and verification, and role handling (USER, ADMIN, SERVICE_BOT).
4. Interactive Opera AI Studio UI & Dashboard: A clean, sleek control center to interactively run OperaDB queries and inspect collections/WAL status, upload/download and stream AES-256-GCM encrypted files, manage users and view storage quotas, test authentication, inspect real-time system logs, and test the REST API endpoints under `/api/v1/opera-ai/*`.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/243ed3a1-e431-48d8-a800-5de71d7c50e4).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
