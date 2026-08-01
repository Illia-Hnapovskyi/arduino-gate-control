import type { SpaceDefenderCopy } from "../i18n";
import type { GameAchievementId } from "../../shared/gameStats";

export type AchievementView = {
  description: string;
  icon: string;
  id: GameAchievementId;
  name: string;
  progress: number;
  rarity: keyof SpaceDefenderCopy["rarity"];
  target: number;
  unlockedAt: string | null;
};

export type CareerStatsView = {
  accuracy: number;
  bossesDefeated: number;
  enemiesDestroyed: number;
  favouritePower: string;
  longestCombo: number;
  longestRunSeconds: number;
  powerupsCollected: number;
  unlockedAchievements: number;
};

export type CareerModeStatsView = {
  difficultyId: "ace" | "cadet" | "pilot";
  gamesPlayed: number;
  highScore: number;
  highestWave: number;
  modeId: "classic" | "expedition" | "survival";
  wins: number;
};

export function AchievementGallery({
  achievements,
  copy,
}: {
  achievements: readonly AchievementView[];
  copy: SpaceDefenderCopy;
}) {
  return (
    <section className="space-achievements-panel">
      <h3>{copy.menuSections.achievements}</h3>
      <p>{copy.achievementsEmpty}</p>
      <div className="space-achievement-grid">
        {achievements.map((achievement) => {
          const target = Number.isFinite(achievement.target)
            ? Math.max(1, Math.floor(achievement.target))
            : 1;
          const progress = Number.isFinite(achievement.progress)
            ? Math.max(0, Math.min(target, Math.floor(achievement.progress)))
            : 0;
          const percent = (progress / target) * 100;
          const status = achievement.unlockedAt
            ? copy.achievementUnlockedOn(copy.formatDate(achievement.unlockedAt))
            : copy.achievementLocked;
          const progressLabel =
            achievement.id === "survivor_5m"
              ? `${copy.formatDuration(progress / 1_000)}/${copy.formatDuration(target / 1_000)}`
              : achievement.id === "sharpshooter"
                ? `${copy.formatAccuracy(progress / 1_000)}/${copy.formatAccuracy(target / 1_000)}`
                : achievement.id === "combo_25"
                  ? `×${copy.formatNumber(progress)}/×${copy.formatNumber(target)}`
                  : `${copy.formatNumber(progress)}/${copy.formatNumber(target)}`;
          return (
            <article className={achievement.unlockedAt ? "is-unlocked" : "is-locked"} key={achievement.id}>
              <span aria-hidden="true" className="achievement-icon">{achievement.icon}</span>
              <div>
                <small>{copy.rarity[achievement.rarity]}</small>
                <h4>{achievement.name}</h4>
                <p>{achievement.description}</p>
                <p className="achievement-status">{status}</p>
                <div className="achievement-progress-row">
                  <div
                    aria-label={`${copy.achievementProgress}: ${copy.formatNumber(Math.round(percent))}%`}
                    aria-valuemax={target}
                    aria-valuemin={0}
                    aria-valuenow={progress}
                    role="progressbar"
                  >
                    <i style={{ width: `${percent}%` }} />
                  </div>
                  <span>{progressLabel}</span>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function CareerStats({
  copy,
  modes,
  stats,
}: {
  copy: SpaceDefenderCopy;
  modes: readonly CareerModeStatsView[];
  stats: CareerStatsView;
}) {
  const entries = [
    [copy.stats.enemies, copy.formatNumber(stats.enemiesDestroyed)],
    [copy.stats.bosses, copy.formatNumber(stats.bossesDefeated)],
    [copy.stats.accuracy, copy.formatAccuracy(stats.accuracy)],
    [copy.stats.combo, `×${copy.formatNumber(stats.longestCombo)}`],
    [copy.stats.favouritePower, stats.favouritePower || "—"],
    [copy.stats.longestRun, copy.formatDuration(stats.longestRunSeconds)],
    [copy.stats.powerups, copy.formatNumber(stats.powerupsCollected)],
    [copy.stats.unlockedAchievements, copy.formatNumber(stats.unlockedAchievements)],
  ] as const;

  return (
    <section className="space-career-panel">
      <h3>{copy.statisticsTitle}</h3>
      <dl>{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <h4>{copy.stats.modeRecords}</h4>
      {modes.length ? (
        <div className="space-mode-records">
          {modes.map((mode) => (
            <article key={`${mode.modeId}:${mode.difficultyId}`}>
              <strong>{copy.modes[mode.modeId].name} · {copy.difficulties[mode.difficultyId].name}</strong>
              <dl>
                <div><dt>{copy.stats.games}</dt><dd>{copy.formatNumber(mode.gamesPlayed)}</dd></div>
                <div><dt>{copy.bestScore}</dt><dd>{copy.formatNumber(mode.highScore)}</dd></div>
                <div><dt>{copy.bestWave}</dt><dd>{copy.formatNumber(mode.highestWave)}</dd></div>
                <div><dt>{copy.stats.wins}</dt><dd>{copy.formatNumber(mode.wins)}</dd></div>
              </dl>
            </article>
          ))}
        </div>
      ) : (
        <p className="space-mode-records-empty">{copy.stats.noModeRecords}</p>
      )}
    </section>
  );
}
