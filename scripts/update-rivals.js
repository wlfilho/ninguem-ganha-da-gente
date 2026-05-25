#!/usr/bin/env node
// Verifica resultados recentes do Flamengo e atualiza data.json.
// Rodado automaticamente via GitHub Actions após cada rodada.

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const BASE_URL = 'https://free-api-live-football-data.p.rapidapi.com';
const FLAMENGO_ID = 9770;
const TRACKED_LEAGUES = new Set([268, 45]); // Brasileirão, Libertadores
const MATCH_BUFFER_MS = 2.5 * 60 * 60 * 1000; // considera encerrado 2.5h após o início

const LEAGUE_NAMES = {
  268: 'Brasileirão Série A',
  45: 'Copa Libertadores',
};

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

// "24.05.2026 02:00" → Date (UTC)
function parseApiTime(timeStr) {
  const [date, time] = timeStr.split(' ');
  const [dd, mm, yyyy] = date.split('.');
  const [hh, min] = time.split(':');
  return new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:00Z`);
}

// "24.05.2026 02:00" → "2026-05-24"
function toIsoDate(timeStr) {
  const [dd, mm, yyyy] = timeStr.split(' ')[0].split('.');
  return `${yyyy}-${mm}-${dd}`;
}

async function getMatchesByDate(dateStr) {
  const resp = await api('/football-get-matches-by-date', { date: dateStr });
  return resp?.matches ?? (Array.isArray(resp) ? resp : []);
}

async function main() {
  if (!RAPIDAPI_KEY) throw new Error('RAPIDAPI_KEY não definida.');

  const dataPath = join(ROOT, 'data.json');
  const data = JSON.parse(readFileSync(dataPath, 'utf8'));

  const rivalByTeamId = new Map(data.rivals.map(r => [r.teamId, r]));
  const processed = new Set(data.processedEventIds ?? []);

  const now = new Date();
  // Verifica ontem e hoje para não perder jogos no fuso horário
  const dates = [
    toApiDate(new Date(now.getTime() - 86400000)),
    toApiDate(now),
  ];

  let changed = false;

  for (const dateStr of dates) {
    console.log(`Buscando jogos de ${dateStr}…`);
    let matches;
    try {
      matches = await getMatchesByDate(dateStr);
    } catch (e) {
      console.error(`  Erro ao buscar ${dateStr}:`, e.message);
      continue;
    }

    for (const match of matches) {
      const id = String(match.id);
      if (processed.has(id)) continue;
      if (!TRACKED_LEAGUES.has(match.leagueId)) continue;

      const isHome = match.home?.id === FLAMENGO_ID;
      const isAway = match.away?.id === FLAMENGO_ID;
      if (!isHome && !isAway) continue;

      // Só processa se o jogo já terminou (horário de início + buffer)
      const kickoff = parseApiTime(match.time);
      if (kickoff.getTime() + MATCH_BUFFER_MS > now.getTime()) {
        console.log(`  Jogo ${id} ainda não encerrado, aguardando.`);
        continue;
      }

      processed.add(id);

      const opponentId = isHome ? match.away?.id : match.home?.id;
      const rival = rivalByTeamId.get(opponentId);

      if (!rival) {
        console.log(`  Flamengo vs time ${opponentId} — não rastreado.`);
        continue;
      }

      const flaScore = isHome ? match.home.score : match.away.score;
      const oppScore = isHome ? match.away.score : match.home.score;
      const oppName = isHome ? match.away.name : match.home.name;
      const league = LEAGUE_NAMES[match.leagueId] ?? 'Campeonato';
      const matchDate = toIsoDate(match.time);

      if (flaScore < oppScore) {
        console.log(`  DERROTA: Flamengo ${flaScore}×${oppScore} ${oppName} — resetando contagem.`);
        rival.lastLoss = matchDate;
        rival.lastScore = `${oppName} ${oppScore}×${flaScore} Flamengo`;
        rival.competition = league;
        rival.gamesSince = 0;
      } else {
        rival.gamesSince += 1;
        console.log(`  Sem derrota vs ${oppName}. gamesSince: ${rival.gamesSince}`);
      }
      changed = true;
    }
  }

  if (changed) {
    data.lastUpdated = now.toISOString().slice(0, 10);
    data.processedEventIds = [...processed];
    writeFileSync(dataPath, JSON.stringify(data, null, 2) + '\n');
    console.log('data.json atualizado com sucesso.');
  } else {
    console.log('Nenhuma atualização necessária.');
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
