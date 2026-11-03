# Auto Job

A Chrome extension and a small local server that apply to jobs for you, and stop before the final Submit so you can review.

When you press **Do it all on this page**, it:

1. **Reads the job.** It takes the title, company, location and description from the page, and clicks *Apply* if the form isn't open yet.
2. **Tailors your resume.** It makes a one-page PDF for that job, using only your real experience.
3. **Writes a cover letter** when the form asks for one, as a file upload or a text box.
4. **Fills every page.** It handles:
   - text, email, phone, number and date fields
   - dropdowns, both native and custom (React-Select, Workday-style)
   - type-to-search boxes (city, school)
   - radio buttons, checkboxes, toggles and Yes/No button groups
   - rich-text boxes
   - fields inside iframes and shadow DOM
   - follow-up questions that appear after an answer
5. **Uploads files**: the tailored resume, the cover letter, and your photo or signature when asked.
6. **Clicks Next / Continue** and fills each following page, up to the final review page.
7. **Waits for you.** It submits only when you press Submit twice. If a page is missing something required, or the site shows a validation error, it stops and tells you what to fix. Then press **Continue**.

**Job board** mode: paste a careers page or job board link. It lists every posting, you tick the ones you want, and it goes through them one at a time.

## How filling stays accurate

- **Reads every field back.** After filling, it checks what the field actually shows. If a value didn't stick, it tries another way.
- **Dropdowns:** opens the list, uses a search box inside it if there is one, scrolls long or lazy lists (like Workday's country list), and falls back to typing the first letters. Options are scored, so "India" beats "Indiana" and "Indonesia", and synonyms count: India = IN = "India (+91)", Yes = "Yes, I am authorized…", Bachelor's = "B.Tech / B.E.".
- **Fixes validation errors.** It reads per-field error messages and the error banner at the top of the page, then corrects those fields:
  - Common errors are fixed instantly in code: phone digits, date formats, missing https://, length limits, numbers-only fields.
  - Everything else goes to the AI, with the site's message and the rejected value.
  - It retries Next up to 3 times before asking you.
- **Repeating sections:** for "Work Experience → Add" and "Education → Add", it adds entries up to your 3 most recent jobs and your degree. Each field is labelled "Work Experience #2 › Job Title", so every job lands in the right entry, with dates in the format the form uses.
- **Tags, dates and staged pages:** skills-style tag inputs get one chip per item. Read-only date pickers are filled in their own format (MM/YYYY, DD/MM/YYYY…). It waits for pages that load fields in stages, and Google Places address boxes get a suggestion picked.
- **Div-based "Search & Select" dropdowns** (Recruit CRM, vue-multiselect, ng-select…) are detected by their placeholder. Their options are read from whatever popup appears when clicked, and every list is closed again, so no option goes to the wrong field.
- **Agreement questions** ("I understand…", "I acknowledge…", "I hereby declare…") are answered "I Agree" / "Yes" instantly and flagged for you. Profile facts fill dropdowns directly (passout year 2027, country, state), and "Post Graduation Year (if applicable)" gets "Not applicable".
- **Documents:** in Profile → Documents, add your 10th and 12th marksheets, ID proof, address proof, degree certificate and transcript once (PDF, PNG or JPG, stored only in `data/documents`). Upload fields asking for them are filled automatically. A passport-size **photo** field gets your photo, never your ID.
- **Never guesses past you.** If a field still can't be filled, the panel says exactly which one and why.

Test pages: http://localhost:8787/test/tricky.html (Workday-style lists, validation errors) and http://localhost:8787/test/oracle.html (Oracle sign-in with a 6-box code).

## Your job boards

The **Job board** tab has one-tap presets for:
- The Job Company: all jobs and internships
- Let's Code
- EngineerHub: internships and jobs
- Debug with Shubham
- Crack Off-Campus

**Scan all my boards** opens each one and merges every posting into one list, shown as "Role — Company · location · pay". Filter it, tick jobs, then press **Start applying**. Use **+ Save board** to add any other site.

- **Multiple Apply steps:** boards often need several "Apply" clicks (job page → countdown page → company careers site). The extension follows up to 4 of them, including ones that open a new tab.
- **Crack Off-Campus:** job details need you to be logged in to the site in Chrome. Premium (paywalled) jobs are marked and left unticked.
- **Let's Code:** its jobs page is currently empty and points to a sign-in-only job finder.

**Wellfound:** the Job board tab also has a **Copy script** button for your Wellfound console script. That script submits without review.

## Hackathons

The **Hacks** tab lists open hackathons from 8 platforms: **Devpost, Unstop, Devfolio, HackerEarth, Hack2skill, lablab.ai, Taikai and HackIndia**.

- **Filters:** search by keyword (AI, web3, a city…), show or hide platforms, and pick online / in person / hybrid. **India / online** limits it to India-based or online events.
- **Sort:** closing soonest, biggest prize, or most popular.
- **Deadlines** are colour-coded: red under 24 h, amber under 4 days.
- **★ Save** a hackathon to keep it on your shortlist.
- **Refreshing:** results are cached for 30 minutes and kept on disk. If a platform is down, its last results stay visible and its chip shows "!".

## Tracker

The **Tracker** tab keeps every application in one place.

- **Statuses:** To apply → Applied → Assessment → Interview 1 / 2 / 3 → HR round → Offer → Accepted, plus Rejected and Withdrawn.
- **Added automatically:** jobs you submit, and jobs you email, are added as *Applied*.
- **Save jobs for later:** on the **Jobs** tab, tick jobs and press **☆ Save to tracker** to save them as *To apply*.
- **On each card:** change the status from its dropdown, add notes (recruiter, test date…), and see a timeline of status changes. *To apply* cards also have an **Apply now** button.
- **Overview:** counters at the top show To apply / In process / Offers / Rejected, with a pipeline bar. Tap a counter to filter.

## Apply by email

Some posts only say "send your resume to hr@…".

1. **Do it all** detects that and opens **Apply by email**. You can also open the section yourself.
2. It writes a short, specific email (no graduation year, "can start immediately"), with your strongest results for that job and your links.
3. It attaches the tailored resume and cover letter.
4. Edit anything you like, then press **Send email** twice. It sends from your Gmail, using the same App Password, and adds the job to the Tracker.

## Setup (once)

```bash
cd server
npm install
cp .env.example .env      # then put your GEMINI_API_KEY in server/.env
```

Load the extension:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `extension` folder.
3. Pin **Auto Job** and click it to open the side panel.

### Using Arc (or any browser)

Click the Auto Job icon: the full panel opens as a floating popup (Arc shows it like other extensions' popups).

- **Long runs** (Do it all, job board queue): a popup can close when you click the page, so press **⧉** in the panel header and choose **Open beside this page** (a tab, which you can put in Arc **Split View**) or **Open in a window**. The popped-out panel keeps working on the last web page you were on.
- **Chrome / Edge / Brave:** ⧉ → **Open side panel**.

Arc setup: open `arc://extensions`, turn on **Developer mode**, then **Load unpacked** the `extension` folder (or click ↻). Pin Auto Job from the puzzle-piece menu.

## Every time

```bash
cd server && npm start
```

### Profile tab
- **Resume(s):** pick one or several resume versions (PDF or DOCX). They are merged into one master profile that keeps every distinct bullet point.
- **Personal details:** date of birth, address, nationality and so on, for forms that ask.
- **Standard answers:** work authorization, notice period, salary, EEO answers.
- **Remembered answers:** answers from forms you submitted, reused next time. Job-dependent answers (sponsorship, salary, "why us?") are never remembered.

### Apply tab
- **Do it all on this page:** runs the full flow above.
- **Settings:**
  - *auto-click Next* (on by default)
  - *cover letter when asked* (on)
  - *only empty fields* (on): leaves alone anything the site already filled, for example after "Autofill from resume".
- **Outlines on the page:** green means filled from your profile or memory. Orange means the AI wrote it or it needs your check. Always read the orange ones.

Your files are stored in `data/`, which is never committed:

| Path | What it holds |
|---|---|
| `data/profile.json` | your profile |
| `data/documents/` | photo and signature |
| `data/resumes/` | every tailored resume and cover letter PDF |
| `data/applications.json` | log of submitted applications |

## Gmail: verification codes and links

Many job sites email you a code, or a "verify your email" link, partway through applying. With Gmail connected:

- **Code fields:** a single box or the 6-box kind is filled automatically. The panel waits up to 2 minutes for the email to arrive.
- **"Check your email" pages:** it finds the verification link and opens it. It only opens links on the job site's own domain, the company's domain or a known applicant-tracking system. Anything else is shown to you with an Open link instead.
- **Read-only:** it reads your inbox and never sends, moves or deletes email.

Setup, once:

1. Turn on 2-Step Verification for your Google account: https://myaccount.google.com/security
2. Create an App Password at https://myaccount.google.com/apppasswords. Name it "Auto Job" and copy the 16-letter password.
3. In `server/.env`, set `GMAIL_USER=you@gmail.com` and paste the password into `GMAIL_APP_PASSWORD=`.
4. Restart the server. The panel header shows **gmail ✓**.

To disconnect, delete the App Password at the same Google page.

**Sign-in pages:** job sites that make you create an account or sign in still need you to type the password. The extension never fills password fields. Chrome's own password manager can fill them for you.

## AI models (`server/.env`)

The default is Gemini:

| Model | Setting | Used for |
|---|---|---|
| `gemini-3.5-flash-lite` | `GEMINI_MODEL` | form answers, about 1–2 s |
| `gemini-3.5-flash` | `GEMINI_HEAVY_MODEL` | resume import, tailoring and cover letters |

**Free-tier quota:** a free key gets about **20 requests per model per day**. The server rotates through several models (`GEMINI_FALLBACK_MODELS`) and skips any that are out of quota until it resets at midnight Pacific time. One application uses about 3–6 requests: one each for the resume and cover letter, and one per form page. For heavier use, enable billing on the key.

**Other providers:**
- **Local:** `LLM_PROVIDER=ollama` runs your local model. It's slower but needs no quota.
- **OpenAI-compatible:** `LLM_PROVIDER=openai`.
- **Claude:** `LLM_PROVIDER=anthropic`.

## How it stays honest

- **Profile fields:** name, email, phone, links, date of birth and address come straight from your profile, with no AI involved.
- **100% keywords switch (Apply tab, off by default):** job keywords you don't have yet go onto a visible **"Familiar with / learning"** line, so keyword filters see full coverage. Bullets, numbers and employers are never invented. Be ready to talk about anything on that line in an interview.
- **Job keywords:** every hard skill in the job description is checked against your resumes, including true synonyms like Postgres = PostgreSQL. Matches go into a "Key skills for this role" line in the job's own spelling, and the cover letter uses them. Skills you don't have are never added. They show as **+ chips**; tap one only if you really have it, and it's saved to your profile.
- **Tailoring:** the AI can only reorder and reword bullets **within the same job**. The server rejects any rewrite that changes or adds numbers, or drifts too far from the original, and keeps your original bullet instead. It also drops skills you never listed.
- **Unknown facts**, like a salary you didn't enter, are left blank and flagged. They are never guessed.
- **Always flagged for review:** AI-written answers, consent checkboxes and empty required fields.

## Limits

- **CAPTCHAs and passwords** need you. Email codes and links are handled once Gmail is connected.
- **Unusual widgets:** some custom date pickers and drag-to-rank questions may need a click from you. They are listed as "pick it yourself".
- **LinkedIn / Indeed terms of service** restrict automation. This tool fills the form for you to review, and never submits unless you press Submit.

## Testing without a real job

With the server running, open one of these in Chrome and use the side panel on it:

- http://localhost:8787/test/form.html: a simple one-page form.
- http://localhost:8787/test/hard.html: a 4-step form with custom widgets, uploads and validation.
