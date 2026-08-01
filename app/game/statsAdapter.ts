import type { GameRunSummaryInput } from "../../shared/gameStats";
import type { GameResultSummary } from "./runtime";
import type { PowerUpId } from "./types";

const MAX_SYNCED_SECTORS = 64;

export function gameResultToStatsInput(
  result: GameResultSummary,
  endedReason: string,
  endedAt = new Date(),
): GameRunSummaryInput {
  const usedPowers = [
    ...new Set<PowerUpId>([
      ...result.metrics.powerUpsUsed,
      ...Object.keys(result.metrics.powerUpsCollectedById ?? {}) as PowerUpId[],
      ...Object.keys(result.metrics.powerUpsActivatedById ?? {}) as PowerUpId[],
    ]),
  ];
  const durationMs = Math.max(0, Math.round(result.durationMs));
  const sectors = result.metrics.sectors
    .slice(-MAX_SYNCED_SECTORS)
    .map((sector, index) => ({
      sectorIndex: index,
      sectorId: sector.sectorId,
      completed: sector.completed,
      livesLost: Math.max(0, Math.floor(sector.livesLost)),
      durationMs: Math.max(0, Math.floor(sector.durationMs)),
    }));
  return {
    runId: result.runId,
    score: Math.max(0, Math.floor(result.score / 10) * 10),
    level: Math.max(1, Math.min(9, result.level)),
    durationMs,
    modeId: result.mode,
    difficultyId: result.difficulty,
    highestWave: Math.max(1, result.wave),
    finalSectorId: result.sector,
    enemiesDestroyed: result.metrics.enemiesDestroyed,
    bossesDefeated: result.metrics.bossesDefeated,
    shotsFired: result.metrics.shotsFired,
    shotsHit: Math.min(result.metrics.shotsFired, result.metrics.shotsHit),
    longestCombo: result.metrics.longestCombo,
    powerupsCollected: result.metrics.powerUpsCollected,
    livesLost: Math.max(0, Math.floor(result.metrics.livesLost)),
    won: result.outcome === "victory",
    inputKind: result.controller,
    endedReason,
    clientEndedAt: endedAt.toISOString(),
    powers: usedPowers.map((powerId) => ({
      powerId,
      collectedCount: result.metrics.powerUpsCollectedById?.[powerId] ?? 0,
      activatedCount:
        result.metrics.powerUpsActivatedById?.[powerId] ??
        (result.metrics.powerUpsUsed.includes(powerId) ? 1 : 0),
    })),
    sectors,
  };
}
