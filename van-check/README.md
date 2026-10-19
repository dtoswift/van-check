# Monthly vehicle checklist (mobile web page)

A phone-first version of the Gaia Monthly Vehicle Check Form. Operatives fill in the checklist, add van photos and sign with a finger. The phone builds a PDF, which they can download or email to their manager.

## How it works

Everything except sending the email happens on the phone. Answers, photos and the signature are autosaved on the device, so a reload, a locked screen or lost signal doesn't lose work. Photos are compressed in the browser and the PDF is built in the browser with jsPDF. The only network request is the email: the phone uploads the finished PDF to `POST /api/send-report`, and the server emails it and discards it straight away. Nothing is written to disk or a database.

```
public/
  index.html     page markup
  styles.css     mobile-first styles
  app.js         form, autosave, photo compression, signature, PDF, download, email
  questions.js   THE CHECKLIST: edit this file when the form changes
  logo.jpg       logo taken from the paper form, printed on the PDF
server.js        static hosting + email endpoint
.env.example     configuration
```

## Libraries

| Library | Where | Why |
|---|---|---|
| jsPDF 2.5.2 | browser (served from node_modules, no CDN) | builds the PDF on the phone |
| Express 4 | server | serves the page and the API |
| Multer 2 | server | receives the PDF upload into memory only |
| Nodemailer 6 | server | sends the email through your SMTP account |
| Helmet 8 | server | security headers and Content-Security-Policy |
| express-rate-limit 7 | server | stops the email endpoint being abused |
| dotenv | server | reads `.env` |

The front end is plain HTML, CSS and JavaScript with no framework and no build step.

## Server-side component (needed only for email)

`server.js` exposes one endpoint, `POST /api/send-report` (multipart form data: `pdf`, `managerEmail`, `operativeName`, `employeeId`, `checkDate`). It:

- keeps the PDF in memory (never on disk) and releases it as soon as the email is handed to the mail server
- only sends to domains listed in `ALLOWED_RECIPIENT_DOMAINS`, and refuses to start in production without that setting, so the page can't be used to email strangers
- checks the upload really is a PDF and caps its size (`MAX_PDF_MB`, default 20 MB)
- rate-limits each connection (default 10 emails per 15 minutes)
- logs only error codes, never names, addresses or content

You need an SMTP account to send from. Options:

- **Microsoft 365 mailbox** (`smtp.office365.com`, port 587, `SMTP_SECURE=false`). SMTP AUTH must be enabled for that mailbox. Microsoft has been retiring basic-auth SMTP in Exchange Online, so check its current status with your IT admin before relying on this.
- **A transactional email service** such as Postmark, SendGrid, Amazon SES or Brevo. This is the most reliable route for automated mail. Verify your sending domain with them so reports don't land in junk.

## Run it locally

Requires Node.js 20 or later.

```bash
npm install
cp .env.example .env      # leave SMTP_HOST empty for test mode
npm start                 # http://localhost:3000
```

With `SMTP_HOST` empty, the server runs in **test mode**. It builds the email but doesn't send it, logs `[dev] Would have emailed …`, and the page shows "(Test mode: no real email was sent.)".

**To test on a real phone:** connect the phone to the same Wi-Fi as your computer and open `http://<your-computer's-IP>:3000`. The camera and photo picker work over plain http. Use HTTPS once the page is live.

## Deploy

Any host that runs Node 20+ and serves HTTPS will work: Azure App Service (convenient if you're a Microsoft 365 business), Render, Railway, Fly.io, or a small VPS behind nginx/Caddy.

1. Push the project (without `.env` or `node_modules`).
2. Build command `npm install`, start command `npm start`.
3. Set these environment variables in the host's dashboard:
   `NODE_ENV=production`, `ALLOWED_RECIPIENT_DOMAINS`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `TRUST_PROXY=1`.
4. Open the HTTPS address on a phone and send one test report to yourself.
5. Share the link with operatives, for example as a QR code in the van or a home-screen bookmark.

## Changing the checklist

Edit `public/questions.js`. Each item's `text` is printed exactly as written, in the order listed. The comments at the top of that file explain every option, including which answers are required, which answers are flagged red as "Needs attention" and which items have a Comments box.

## Failure handling

| What goes wrong | What the operative sees | Their work |
|---|---|---|
| Mandatory item skipped | Count of missing answers. The page scrolls to the first one, and each missing item is outlined in red with an instruction. | Kept |
| Photo won't open (corrupt file, unsupported format) | "One photo couldn't be opened. Take it again, or choose a different photo." The other photos are still added. | Kept |
| Photo saved but won't display later | Red outline on that photo and "Remove it and add it again". PDF creation is blocked until it's fixed. | Kept |
| No signal when sending | "No signal. Keep this page open: the PDF will send by itself when your signal comes back." | Kept |
| Connection drops or times out mid-upload | Retries automatically (3 attempts with backoff), then shows "Try sending again". | Kept |
| Email server rejects or is down | Plain message, a "Try sending again" button, and a suggestion to download the PDF and email it themselves. | Kept |
| Wrong or non-company email | Inline message before anything is sent. The server checks again. | Kept |
| Page reloaded or phone restarted | "Your unfinished check from Monday at 11:11 has been restored." | Restored |

## Privacy

- **Server:** nothing is stored. The PDF exists in memory for the few seconds it takes to email it.
- **Phone:** answers, photos and signature are kept only until the email is sent, the operative taps "Finish and clear this check from my phone", or 3 days pass, whichever comes first.
- **Operatives can't see each other's submissions:** there is no shared storage and no list of past checks. Each phone only ever holds its own draft.
- Photos may show registration plates or people, which is personal data. They go only to the manager address the operative confirms.
