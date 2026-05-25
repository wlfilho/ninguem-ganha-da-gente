#!/usr/bin/env node
// Baixa o calendário de jogos do Flamengo no Brasileirão e Libertadores.
// Salva em schedule.json. Rodar manualmente ou via GitHub Actions toda segunda-feira.

import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const BASE_URL = 'https://free-api-live-football-data.p.rapidapi.com';
const FLAMENGO_ID = 9770;

const COMPETITIONS = [
  { leagueId: 268, name: 'Brasileirão Série A' },
  { leagueId: 45, name: 'Copa Libertadores' },
  // { leagueId: 73, name: 'Copa do Brasil' }, // descomentar quando Flamengo voltar
];

const DAYS_BACK = 30;   // jogos passados (para histórico recente)
const DAYS_AHEAD = 90;  // jogos futuros

async function api(path, params = {}) {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), {
    headers: {
      'x-rapidapi-host': 'free-api-live-football-data.p.rapidapi.com',
      'x-rapidapi-key': RAPIDAPI_KEY,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`API ${path} retornou ${res.status}`);
  const json = await res.json();
  return json.response;
}

function toApiDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  if (!RAPIDAPI_KEY) throw new Error('RAPIDAPI_KEY não definida.');

  const trackedLeagues = new Set(COMPETITIONS.map(c => c.leagueId));
  const leagueName = Object.fromEntries(COMPETITIONS.map(c => [c.leagueId, c.name]));

  const games = [];
  const seenIds = new Set();
  const now = new Date();
  const totalDays = DAYS_BACK + DAYS_AHEAD;

  console.log(`Escaneando ${totalDays} dias em busca de jogos do Flamengo…`);

  for (let i = 0; i < totalDays; i++) {
    const d = new Date(now.getTime() + (i - DAYS_BACK) * 86400000);
    const dateStr = toApiDate(d);

    let matches;
    try {
      const resp = await api('/football-get-matches-by-date', { date: dateStr });
      matches = resp?.matches ?? (Array.isArray(resp) ? resp : []);
    } catch (e) {
      console.warn(`  Pulando ${dateStr}: ${e.message}`);
      await sleep(500);
      continue;
    }

    for (const match of matches) {
      if (seenIds.has(match.id)) continue;
      if (!trackedLeagues.has(match.leagueId)) continue;
      if (match.home?.id !== FLAMENGO_ID && match.away?.id !== FLAMENGO_ID) continue;

      seenIds.add(match.id);
      games.push({
        eventId: match.id,
        competition: leagueName[match.leagueId],
        leagueId: match.leagueId,
        date: match.time,
        home: match.home?.name,
        homeId: match.home?.id,
        away: match.away?.name,
        awayId: match.away?.id,
        homeScore: match.home?.score ?? null,
        awayScore: match.away?.score ?? null,
      });
    }

    process.stdout.write(`\r  ${i + 1}/${totalDays} dias · ${games.length} jogos encontrados`);
    await sleep(150); // respeita rate limit
  }

  console.log('\n');
  games.sort((a, b) => a.date.localeCompare(b.date));

  const outPath = join(ROOT, 'schedule.json');
  writeFileSync(outPath, JSON.stringify({ updatedAt: now.toISOString(), games }, null, 2) + '\n');
  console.log(`schedule.json salvo com ${games.length} jogos do Flamengo.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
