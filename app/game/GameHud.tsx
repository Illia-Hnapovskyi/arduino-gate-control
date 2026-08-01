import type { SpaceDefenderCopy } from "../i18n";
import type { UpgradeId } from "./types";

type GameHudProps = {
  bossHealth?: number;
  bossMaxHealth?: number;
  bossPhase?: number;
  combo: number;
  copy: SpaceDefenderCopy;
  energy: number;
  lives: number;
  maxLives: number;
  phase: "telegraph" | "combat" | "rest" | "boss";
  powerActiveRemaining: number;
  powerCooldown: number;
  powerEnergyCost: number;
  powerName: string;
  score: number;
  sectorName: string;
  shield: number;
  upgrades: readonly { id: UpgradeId; stacks: number }[];
  maxShield: number;
  wave: number;
};

export function GameHud({
  bossHealth,
  bossMaxHealth,
  bossPhase,
  combo,
  copy,
  energy,
  lives,
  maxLives,
  phase,
  powerActiveRemaining,
  powerCooldown,
  powerEnergyCost,
  powerName,
  score,
  sectorName,
  shield,
  maxShield,
  upgrades,
  wave,
}: GameHudProps) {
  const safeMaxLives = Number.isFinite(maxLives)
    ? Math.max(1, Math.floor(maxLives))
    : 1;
  const safeLives = Number.isFinite(lives)
    ? Math.max(0, Math.min(safeMaxLives, Math.floor(lives)))
    : 0;
  const safeEnergy = Number.isFinite(energy)
    ? Math.max(0, Math.min(100, energy))
    : 0;
  const safeMaxShield = Number.isFinite(maxShield)
    ? Math.max(1, maxShield)
    : 1;
  const safeShield = Number.isFinite(shield)
    ? Math.max(0, Math.min(safeMaxShield, shield))
    : 0;
  const shieldPercent = (safeShield / safeMaxShield) * 100;
  const safeBossMaxHealth =
    bossMaxHealth !== undefined && Number.isFinite(bossMaxHealth)
      ? Math.max(1, bossMaxHealth)
      : 1;
  const safeBossHealth =
    bossHealth !== undefined && Number.isFinite(bossHealth)
      ? Math.max(0, Math.min(safeBossMaxHealth, bossHealth))
      : 0;
  const bossPercent =
    bossHealth !== undefined && bossMaxHealth !== undefined
      ? (safeBossHealth / safeBossMaxHealth) * 100
      : 0;

  return (
    <div className="space-hud">
      <div className="space-hud-primary">
        <div><small>{copy.hud.score}</small><strong>{copy.formatNumber(score).padStart(6, "0")}</strong></div>
        <div>
          <small>{copy.hud.lives}</small>
          <strong aria-label={`${copy.hud.lives}: ${copy.formatNumber(safeLives)} / ${copy.formatNumber(safeMaxLives)}`} className="space-hull">
            {Array.from({ length: safeMaxLives }, (_, index) => (
              <i className={index < safeLives ? "is-full" : ""} key={index} />
            ))}
          </strong>
        </div>
        <div><small>{copy.hud.wave}</small><strong>{copy.formatNumber(wave)}</strong></div>
        <div><small>{copy.hud.combo}</small><strong>×{copy.formatNumber(Math.max(0, combo))}</strong></div>
      </div>

      <div className="space-hud-context">
        <span className={`space-phase-chip is-${phase}`}>
          {phase === "telegraph"
            ? copy.hud.telegraph
            : phase === "rest"
              ? copy.hud.rest
              : phase === "boss"
                ? copy.hud.danger
                : copy.hud.sector}
        </span>
        <strong>{sectorName}</strong>
      </div>

      <div className="space-energy-cluster">
        <div className="space-resource-row">
          <div className="space-energy-label">
            <span>{copy.hud.energy}</span>
            <strong>{copy.formatNumber(Math.round(safeEnergy))}%</strong>
          </div>
          <div
            aria-label={`${copy.hud.energy}: ${copy.formatNumber(Math.round(safeEnergy))}%`}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(safeEnergy)}
            className="space-energy-meter"
            role="progressbar"
          >
            <i style={{ width: `${safeEnergy}%` }} />
          </div>
        </div>
        <div className="space-resource-row">
          <div className="space-energy-label">
            <span>{copy.hud.shield}</span>
            <strong>{copy.formatNumber(Math.round(shieldPercent))}%</strong>
          </div>
          <div
            aria-label={`${copy.hud.shield}: ${copy.formatNumber(Math.round(safeShield))} / ${copy.formatNumber(safeMaxShield)}`}
            aria-valuemax={safeMaxShield}
            aria-valuemin={0}
            aria-valuenow={Math.round(safeShield)}
            className="space-energy-meter is-shield"
            role="progressbar"
          >
            <i style={{ width: `${shieldPercent}%` }} />
          </div>
        </div>
        <small className="space-power-status">
          <span>{powerName} · {copy.powerCost}: {copy.formatNumber(powerEnergyCost)}</span>
          <strong>
            {powerActiveRemaining > 0
              ? `${copy.powerActive}: ${copy.formatCooldown(powerActiveRemaining)}`
              : powerCooldown <= 0
                ? copy.cooldownReady
                : `${copy.hud.cooldown}: ${copy.formatCooldown(powerCooldown)}`}
          </strong>
        </small>
      </div>

      {upgrades.length > 0 && (
        <ul aria-label={copy.activeUpgrades} className="space-upgrade-chips">
          {upgrades.map((upgrade) => (
            <li key={upgrade.id}>
              {copy.upgrades[upgrade.id].name} ×{copy.formatNumber(upgrade.stacks)}
            </li>
          ))}
        </ul>
      )}

      {bossHealth !== undefined && bossMaxHealth !== undefined && (
        <div className="space-boss-meter">
          <div>
            <span>{copy.hud.bossIntegrity} · {copy.formatNumber(Math.round(bossPercent))}%</span>
            <strong>{copy.bossPhaseLabel} {copy.formatNumber(bossPhase ?? 1)}</strong>
          </div>
          <div
            aria-label={`${copy.hud.bossIntegrity}: ${copy.formatNumber(Math.round(bossPercent))}%`}
            aria-valuemax={safeBossMaxHealth}
            aria-valuemin={0}
            aria-valuenow={Math.round(safeBossHealth)}
            role="progressbar"
          >
            <i style={{ width: `${bossPercent}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}
