// Internships 2027 (github.com/zapplyjobs/Internships-2027): a curated list of tech internships that
// updates every few minutes. Parsed server-side from the repo's README table into the same job shape the
// panel's board scan produces, so it joins the Jobs list like any board (ranked, filterable, applicable).
let cache = { at: 0, jobs: [] };
const README_URL = 'https://raw.githubusercontent.com/zapplyjobs/Internships-2027/main/README.md';

export async function listInternships({ refresh = false } = {}) {
  if (!refresh && cache.jobs.length && Date.now() - cache.at < 10 * 60_000) return { jobs: cache.jobs, cached: true };
  const res = await fetch(README_URL, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'AutoJob (local tool)' } });
  if (!res.ok) throw new Error(`Internships 2027 list: ${res.status}`);
  const jobs = [];
  for (const line of (await res.text()).split('\n')) {
    if (!line.startsWith('|') || /^[-|\s]+$/.test(line) || /Company \| Role/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 6) continue;
    const company = cells[0].replace(/\*\*/g, '').trim();
    const role = cells[1].replace(/\*\*/g, '').trim();
    const link = (cells[5].match(/\]\((https?:[^)\s]+)\)/) || [])[1];
    if (!company || !role || !link) continue;
    jobs.push({
      title: role,
      company,
      url: link,
      meta: [cells[2].replace(/\.\.\.$/, ''), cells[3] ? `posted ${cells[3]}` : '', /sponsor/i.test(cells[4]) ? 'visa sponsorship' : ''].filter(Boolean).join(' · '),
    });
  }
  if (!jobs.length) throw new Error('The Internships 2027 list came back empty (format changed?)');
  cache = { at: Date.now(), jobs: jobs.slice(0, 800) };
  return { jobs: cache.jobs, cached: false };
}
