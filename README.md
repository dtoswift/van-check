# Monthly vehicle checklist (mobile web page)

A phone-first version of the Gaia Monthly Vehicle Check Form, built to run on GitHub Pages. Operatives fill in the checklist, add van photos and sign with a finger. The phone builds a PDF, which they download or email to their manager from their own email app.

Live page: https://dtoswift.github.io/Van-Form/

## How it works

The whole page runs on the phone, with no server. Answers, photos and the signature are autosaved on the device, so a reload, a locked screen or lost signal doesn't lose work. Photos are compressed on the phone and the PDF is built on the phone with jsPDF.

To email the PDF, the operative enters their manager's address and confirms it. The page copies the address and opens the phone's share sheet with the PDF attached. They pick their email app, paste the address into To, and send it from their own email. On a phone that can't share files, the page downloads the PDF and opens the email app with the address, subject and message filled in, ready for them to attach the file.

Once the page has been opened once, it also opens with no signal.

## Files

| File | What it does |
|---|---|
| index.html | the page |
| styles.css | the look of the page |
| app.js | form, autosave, photos, signature, PDF, download, email |
| questions.js | **the checklist: edit this file when the form changes** |
| logo.jpg | logo printed on the page and the PDF |
| sw.js | lets the page open with no signal |
| vendor/jspdf.umd.min.js | the PDF library (jsPDF 2.5.2) |

All files must stay at the top level of the repository, with the PDF library inside the vendor folder, for GitHub Pages to serve them.

## Changing the checklist

Edit `questions.js` on GitHub (open it, click the pencil icon, make the change, then click "Commit changes"). Each item's `text` is printed exactly as written, in the order listed. The notes at the top of the file explain every option. To restrict the manager's email to company addresses, put your domain in `managerEmailDomains`, for example `['gaiaclimatesolutions.co.uk']`. Changes go live within a minute or two.

## Privacy

Nothing is stored on any server. Each phone holds only its own unfinished check, which is cleared when the operative taps "Finish and clear this check from my phone", or automatically after 3 days. The PDF goes only to the address the operative sends it to.
