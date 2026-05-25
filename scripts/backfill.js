#!/usr/bin/env node
// Escaneia o histórico de jogos do Flamengo de trás pra frente, dia por dia.
// Salva o progresso em backfill-progress.json para continuar em execuções futuras.
// Limite de N_CALLS_PER_RUN chamadas por execução para respeitar o free tier da API.
//
// Uso:
//   RAPIDAPI_KEY=xxx node scripts/backfill.js
//
// Quando "completed: true" aparecer, rode:
//   node scripts/apply-backfill.js

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const BASE_URL = 'https://free-api-live-football-data.p.rapidapi.com';
const FLAMENGO_ID = 9770;
const N_CALLS_PER_RUN = 400;   // máximo de chamadas por execução (free tier = 500/dia)
const CUTOFF_DATE = '20210101'; // não vai além disso

const TRACKED_LEAGUES = new Map([
  [268,   'Brasileirão Série A'],
  [45,    'Copa Libertadores'],
  [10272, 'Campeonato Carioca'],
  [9067,  'Copa do Brasil'],
  [10077, 'Supercopa do Brasil'],
  [491,   'Recopa Sul-Americana'],
]);

// ── helpers de data ──────────────────────────────────────────────────────────

function toApiDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function prevDay(dateStr) {
  const y = parseInt(dateStr.slice(0, 4));
  const m = parseInt(dateStr.slice(4, 6)) - 1;
  const d = parseInt(dateStr.slice(6, 8));
  const date = new Date(Date.UTC(y, m, d));
  date.setUTCDate(date.getUTCDate() - 1);
  return toApiDate(date);
}

function toIsoDate(apiDate) {
  return `${apiDate.slice(0, 4)}-${apiDate.slice(4, 6)}-${apiDate.slice(6, 8)}`;
}

// ── API ──────────────────────────────────────────────────────────────────────

async function api(path, params = {}) {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), {
    headers: {
      'x-rapidapi-host': 'free-api-live-football-data.p.rapidapi.com',
      'x-rapidapi-key': RAPIDAPI_KEY,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json.response;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── progresso ────────────────────────────────────────────────────────────────

const PROGRESS_PATH = join(ROOT, 'backfill-progress.json');

function loadProgress() {
  if (existsSync(PROGRESS_PATH)) {
    return JSON.parse(readFileSync(PROGRESS_PATH, 'utf8'));
  }
  return {
    startedAt: new Date().toISOString(),
    nextDate: toApiDate(new Date()), // começa de hoje e vai para trás
    completed: false,
    matches: [],
  };
}

function saveProgress(p) {
  writeFileSync(PROGRESS_PATH, JSON.stringify(p, null, 2) + '\n');
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!RAPIDAPI_KEY) throw new Error('RAPIDAPI_KEY não definida.');

  const data = JSON.parse(readFileSync(join(ROOT, 'data.json'), 'utf8'));
  const rivalByTeamId = new Map(data.rivals.map(r => [r.teamId, r]));

  const progress = loadProgress();

  if (progress.completed) {
    console.log('Backfill já concluído. Rode: node scripts/apply-backfill.js');
    return;
  }

  const seenEventIds = new Set(progress.matches.map(m => m.eventId));
  let calls = 0;
  let currentDate = progress.nextDate;

  console.log(`Retomando em ${currentDate} | já coletados: ${progress.matches.length} jogos\n`);

  while (calls < N_CALLS_PER_RUN && currentDate >= CUTOFF_DATE) {
    let matches = [];
    try {
      const resp = await api('/football-get-matches-by-date', { date: currentDate });
      matches = resp?.matches ?? (Array.isArray(resp) ? resp : []);
      calls++;
    } catch (e) {
      console.warn(`\n  Erro em ${currentDate}: ${e.message} — pulando.`);
      await sleep(1000);
      currentDate = prevDay(currentDate);
      continue;
    }

    for (const match of matches) {
      if (seenEventIds.has(match.id)) continue;
      if (!TRACKED_LEAGUES.has(match.leagueId)) continue;

      const isHome = match.home?.id === FLAMENGO_ID;
      const isAway = match.away?.id === FLAMENGO_ID;
      if (!isHome && !isAway) continue;

      const opponentId = isHome ? match.away?.id : match.home?.id;
      const rival = rivalByTeamId.get(opponentId);
      if (!rival) continue;

      const flaScore = isHome ? match.home?.score : match.away?.score;
      const oppScore = isHome ? match.away?.score : match.home?.score;

      // Ignora jogos sem placar (não realizados ou cancelados)
      if (flaScore == null || oppScore == null) continue;

      seenEventIds.add(match.id);
      const entry = {
        date: toIsoDate(currentDate),
        eventId: match.id,
        leagueId: match.leagueId,
        competition: TRACKED_LEAGUES.get(match.leagueId),
        rivalId: rival.id,
        rivalName: isHome ? match.away.name : match.home.name,
        flamengoScore: flaScore,
        rivalScore: oppScore,
        flamengoLost: flaScore < oppScore,
      };
      progress.matches.push(entry);

      const result = entry.flamengoLost ? '❌ DERROTA' : '✅';
      console.log(`  ${currentDate} [${entry.competition}] ${rival.id}: Fla ${flaScore}×${oppScore} — ${result}`);
    }

    process.stdout.write(`\r  ${currentDate} | ${calls}/${N_CALLS_PER_RUN} chamadas | ${progress.matches.length} jogos`);
    await sleep(200);
    currentDate = prevDay(currentDate);
  }

  console.log('\n');

  progress.nextDate = currentDate;
  progress.completed = currentDate < CUTOFF_DATE;

  saveProgress(progress);

  if (progress.completed) {
    console.log('✅ Backfill concluído! Rode: node scripts/apply-backfill.js');
  } else {
    const pct = Math.round(
      (1 - (currentDate - CUTOFF_DATE) / (progress.startedAt.slice(0, 10).replace(/-/g, '') - CUTOFF_DATE)) * 100
    );
    console.log(`Parcial. Continuação em: ${currentDate}`);
    console.log('Rode novamente amanhã (ou adicione ao cron do GitHub Actions).');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
