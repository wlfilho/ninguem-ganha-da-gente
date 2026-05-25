#!/usr/bin/env node
// Lê backfill-progress.json e deriva lastLoss + gamesSince para cada rival.
// Atualiza data.json com os valores históricos corretos.
//
// Uso:
//   node scripts/apply-backfill.js
//
// Só rode quando backfill-progress.json tiver "completed: true".

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function main() {
  const progressPath = join(ROOT, 'backfill-progress.json');
  if (!existsSync(progressPath)) {
    console.error('backfill-progress.json não encontrado. Rode backfill.js primeiro.');
    process.exit(1);
  }

  const progress = JSON.parse(readFileSync(progressPath, 'utf8'));
  const data = JSON.parse(readFileSync(join(ROOT, 'data.json'), 'utf8'));

  if (!progress.completed) {
    console.warn('⚠️  Backfill ainda não concluído — os dados podem estar incompletos.');
    console.warn('   Continue rodando backfill.js até "completed: true".\n');
  }

  // Agrupa os jogos por rival e ordena por data crescente
  const byRival = {};
  for (const match of progress.matches) {
    (byRival[match.rivalId] ??= []).push(match);
  }
  for (const list of Object.values(byRival)) {
    list.sort((a, b) => a.date.localeCompare(b.date));
  }

  const processed = new Set(data.processedEventIds ?? []);

  for (const rival of data.rivals) {
    const matches = byRival[rival.id];

    if (!matches?.length) {
      console.log(`${rival.id}: nenhum jogo encontrado no backfill — mantendo valores atuais.`);
      continue;
    }

    // Última derrota: jogo mais recente onde flamengoLost === true
    const lastLossMatch = [...matches].reverse().find(m => m.flamengoLost);

    if (!lastLossMatch) {
      // Nenhuma derrota encontrada no período — Fla não perdeu pra esse rival
      rival.gamesSince = matches.length;
      console.log(`${rival.id}: sem derrota no período. gamesSince=${rival.gamesSince}`);
    } else {
      rival.lastLoss    = lastLossMatch.date;
      rival.lastScore   = `${lastLossMatch.rivalName} ${lastLossMatch.rivalScore}×${lastLossMatch.flamengoScore} Flamengo`;
      rival.competition = lastLossMatch.competition;
      rival.gamesSince  = matches.filter(m => m.date > lastLossMatch.date).length;

      console.log(`${rival.id}: lastLoss=${rival.lastLoss} (${rival.lastScore}) | gamesSince=${rival.gamesSince}`);
    }

    // Marca todos os eventos do backfill como processados (update-rivals não os re-processa)
    for (const m of matches) processed.add(String(m.eventId));
  }

  data.processedEventIds = [...processed];
  data.lastUpdated = new Date().toISOString().slice(0, 10);

  writeFileSync(join(ROOT, 'data.json'), JSON.stringify(data, null, 2) + '\n');
  console.log('\n✅ data.json atualizado com os dados históricos do backfill.');
}

main();
