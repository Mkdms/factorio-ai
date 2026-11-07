/**
 * The stream site's polls (pog, d16 17:15): when a poll opens, the agent's next reply carries one fact line in its team
 * block (`team.poll`), once per poll; nothing after. The poll data is pog's RUN/polls.json (site/polls_relay.py keeps
 * it fresh; FH_POLLS_FILE overrides); the polls already said are in FH_POLLS_SEEN (default .fh-polls-seen.json next to
 * the journal). Host-side only: the game is not asked.
 */
import { readFileSync, writeFileSync } from 'node:fs';
function left(seconds) {
    const m = Math.max(0, Math.round(seconds / 60));
    return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
}
/** The team-block line for one open poll. */
export function pollLine(p, nowS) {
    const options = Array.isArray(p.options) ? p.options.map((o, i) => `${i} ${String(o)}`).join('; ') : '';
    return `poll #${p.id} open on the stream's site, closes in ${left(Number(p.closes) - nowS)}: ${String(p.question)} `
        + `Options: ${options}. Vote: ./fh poll vote --args '{"id":${p.id},"option":K,"comment":"..."}' `
        + `(one vote per agent, a later one replaces it; ./fh poll shows the intro, each option's details and the counts)`;
}
/** The lines for open polls not said yet, and the ids said after this (polls no longer open drop out of it). */
export function pollAnnouncements(data, seen, nowS) {
    const open = data && typeof data === 'object' && Array.isArray(data.open)
        ? (data.open).filter(p => typeof p?.id === 'number' && p.status === 'open' && Number(p.closes) > nowS)
        : [];
    const fresh = open.filter(p => !seen.includes(p.id));
    return { lines: fresh.map(p => pollLine(p, nowS)), seen: [...seen, ...fresh.map(p => p.id)].slice(-200) };
}
/** Read both files, say what is new, save the ids said. Any read or write failure says nothing. */
export function pollNews(pollsFile, seenFile, nowMs) {
    let data;
    try {
        data = JSON.parse(readFileSync(pollsFile, 'utf8'));
    }
    catch {
        return [];
    }
    let seen = [];
    try {
        const saved = JSON.parse(readFileSync(seenFile, 'utf8'));
        if (Array.isArray(saved.seen))
            seen = saved.seen.filter((x) => typeof x === 'number');
    }
    catch { /* none said yet */ }
    const { lines, seen: next } = pollAnnouncements(data, seen, nowMs / 1000);
    if (!lines.length)
        return [];
    try {
        writeFileSync(seenFile, JSON.stringify({ seen: next }) + '\n');
    }
    catch {
        return [];
    }
    return lines;
}
//# sourceMappingURL=polls.js.map