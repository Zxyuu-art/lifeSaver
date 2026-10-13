# LifeSaver

LifeSaver is a personal life administration and reminder platform. This project is ready for deployment to a cloud host and uses a PostgreSQL cloud database.

## Tech stack

- Node.js + Express
- PostgreSQL (cloud database)
- EJS templates
- Session-based authentication

## Local setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the environment file:
   ```bash
   cp .env.example .env
   ```
3. Fill in your local or cloud PostgreSQL URL in `.env`.
4. Optionally set `SUPPORT_EMAIL` to the customer-service email address shown on the public homepage.
5. Start the app:
   ```bash
   npm start
   ```
5. Open http://localhost:3000

## Cloud database setup

This app supports Supabase PostgreSQL. In Supabase, open **Project Settings > Database** and copy a PostgreSQL connection string. Set it as `DATABASE_URL` in `.env` for local development or in your cloud host's environment variables. The app creates its tables when it starts.

Keep the connection string private and never commit `.env`. Uploaded documents are currently stored on the app server's local disk; configure Supabase Storage separately if those files also need cloud persistence.

## Deployment to Render

1. Push this folder to GitHub.
2. Create a new Web Service on Render.
3. Connect the repository.
4. Set environment variables:
   - `DATABASE_URL`
   - `SESSION_SECRET`
   - `SUPPORT_EMAIL` (optional)
5. Deploy.

## Main features

- User registration and login
- Dashboard with urgent/upcoming/safe counts
- Add life admin items
- Reminder generation by due date
- Timeline view
- Document upload support
- Real database persistence
