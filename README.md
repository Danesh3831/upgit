
# Ketchup - Telegram Bot

A Telegram bot built with JavaScript and Cloudflare Workers using Webhooks.

## Overview

This project is a Telegram bot designed to run on Cloudflare Workers.
It receives Telegram updates through a Webhook endpoint.

## Technologies

- JavaScript
- Cloudflare Workers
- Telegram Bot API
- SQL Migrations

## Project Structure

```text
.
├── src/
│   └── index.js
├── migrations/
│   ├── 0001_init.sql
│   ├── 0002_reminders.sql
│   └── 0003_daily_digest_dedup.sql
├── test/
├── package.json
├── wrangler.jsonc
└── README.md
```

## Database Migrations

SQL migration files are stored in the `migrations/` directory.

## Security

Never commit bot tokens, API keys, passwords, or other secrets.

Configure sensitive values using Cloudflare Worker Secrets.

## License

Add your project license here.
