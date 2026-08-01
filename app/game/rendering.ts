import { SECTOR_BALANCE } from "./balance.ts";
import type {
  BossRuntime,
  EnemyRuntime,
  GameWorld,
  HitEffectRuntime,
  PickupRuntime,
  ProjectileRuntime,
} from "./runtime.ts";

export type RenderGameWorldOptions = {
  reducedMotion?: boolean;
  screenShake?: boolean;
  shakeScale?: number;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function noise(seed: number, index: number, salt = 0) {
  let value = (seed ^ Math.imul(index + 1, 0x45d9f3b) ^ salt) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 4_294_967_296;
}

function wrap(value: number, maximum: number) {
  return ((value % maximum) + maximum) % maximum;
}

function polygon(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  points: number,
  rotation = 0,
  wobble = 0,
) {
  context.beginPath();
  for (let index = 0; index < points; index++) {
    const angle = rotation + (index / points) * Math.PI * 2;
    const pointRadius = radius * (1 - wobble * (index % 2));
    const pointX = x + Math.cos(angle) * pointRadius;
    const pointY = y + Math.sin(angle) * pointRadius;
    if (index === 0) context.moveTo(pointX, pointY);
    else context.lineTo(pointX, pointY);
  }
  context.closePath();
}

function drawBackground(
  context: CanvasRenderingContext2D,
  world: GameWorld,
) {
  const sector = SECTOR_BALANCE[world.sector];
  const gradient = context.createLinearGradient(0, 0, 0, world.height);
  gradient.addColorStop(0, sector.backgroundTop);
  gradient.addColorStop(1, sector.backgroundBottom);
  context.fillStyle = gradient;
  context.fillRect(0, 0, world.width, world.height);

  const glow = context.createRadialGradient(
    world.width * 0.72,
    world.height * 0.18,
    0,
    world.width * 0.72,
    world.height * 0.18,
    world.width * 0.72,
  );
  glow.addColorStop(0, `${sector.accent}2e`);
  glow.addColorStop(1, `${sector.accent}00`);
  context.fillStyle = glow;
  context.fillRect(0, 0, world.width, world.height);
}

function drawStarParticles(
  context: CanvasRenderingContext2D,
  world: GameWorld,
  count: number,
  motion: number,
) {
  for (let index = 0; index < count; index++) {
    const x = noise(world.seed, index, 11) * world.width;
    const speed = 12 + noise(world.seed, index, 19) * 72;
    const y = wrap(
      noise(world.seed, index, 23) * world.height + world.elapsedMs * 0.001 * speed * motion,
      world.height + 16,
    ) - 8;
    const size = 0.7 + noise(world.seed, index, 31) * 2.2;
    context.fillStyle = `rgba(235,255,250,${0.25 + noise(world.seed, index, 37) * 0.7})`;
    context.beginPath();
    context.arc(x, y, size, 0, Math.PI * 2);
    context.fill();
  }
}

function drawMistParticles(
  context: CanvasRenderingContext2D,
  world: GameWorld,
  count: number,
  motion: number,
) {
  for (let index = 0; index < count; index++) {
    const radius = 45 + noise(world.seed, index, 41) * 105;
    const x = wrap(
      noise(world.seed, index, 43) * world.width + world.elapsedMs * 0.006 * motion,
      world.width + radius * 2,
    ) - radius;
    const y = noise(world.seed, index, 47) * world.height;
    const mist = context.createRadialGradient(x, y, 0, x, y, radius);
    mist.addColorStop(0, "rgba(197,140,255,0.095)");
    mist.addColorStop(1, "rgba(197,140,255,0)");
    context.fillStyle = mist;
    context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
}

function drawRockParticles(
  context: CanvasRenderingContext2D,
  world: GameWorld,
  count: number,
  motion: number,
) {
  context.fillStyle = "rgba(242,182,141,0.2)";
  context.strokeStyle = "rgba(242,182,141,0.32)";
  for (let index = 0; index < count; index++) {
    const radius = 3 + noise(world.seed, index, 53) * 8;
    const x = noise(world.seed, index, 59) * world.width;
    const y = wrap(
      noise(world.seed, index, 61) * world.height + world.elapsedMs * 0.025 * motion,
      world.height + 30,
    ) - 15;
    polygon(
      context,
      x,
      y,
      radius,
      6,
      world.elapsedMs * 0.0003 * motion + index,
      0.2,
    );
    context.fill();
    context.stroke();
  }
}

function drawCrystalParticles(
  context: CanvasRenderingContext2D,
  world: GameWorld,
  count: number,
  motion: number,
) {
  context.strokeStyle = "rgba(168,232,255,0.48)";
  for (let index = 0; index < count; index++) {
    const x = noise(world.seed, index, 67) * world.width;
    const y = wrap(
      noise(world.seed, index, 71) * world.height + world.elapsedMs * 0.012 * motion,
      world.height + 24,
    ) - 12;
    const size = 4 + noise(world.seed, index, 73) * 9;
    context.beginPath();
    context.moveTo(x, y - size);
    context.lineTo(x + size * 0.45, y);
    context.lineTo(x, y + size);
    context.lineTo(x - size * 0.45, y);
    context.closePath();
    context.stroke();
  }
}

function drawIonParticles(
  context: CanvasRenderingContext2D,
  world: GameWorld,
  count: number,
  motion: number,
) {
  context.lineWidth = 1.5;
  for (let index = 0; index < count; index++) {
    const x = noise(world.seed, index, 79) * world.width;
    const baseY = noise(world.seed, index, 83) * world.height;
    const y = baseY + Math.sin(world.elapsedMs * 0.004 * motion + index) * 28;
    const length = 8 + noise(world.seed, index, 89) * 24;
    context.strokeStyle = `rgba(154,255,107,${0.18 + noise(world.seed, index, 97) * 0.45})`;
    context.beginPath();
    context.moveTo(x - length, y + length * 0.3);
    context.lineTo(x, y - length * 0.2);
    context.lineTo(x + length, y + length * 0.2);
    context.stroke();
  }
}

function drawWreckageParticles(
  context: CanvasRenderingContext2D,
  world: GameWorld,
  count: number,
  motion: number,
) {
  for (let index = 0; index < count; index++) {
    const x = noise(world.seed, index, 101) * world.width;
    const y = wrap(
      noise(world.seed, index, 103) * world.height + world.elapsedMs * 0.01 * motion,
      world.height + 60,
    ) - 30;
    const width = 8 + noise(world.seed, index, 107) * 26;
    context.save();
    context.translate(x, y);
    context.rotate(world.elapsedMs * 0.0002 * motion + index);
    context.strokeStyle = "rgba(212,179,143,0.35)";
    context.strokeRect(-width / 2, -3, width, 6);
    context.beginPath();
    context.moveTo(-width * 0.2, -8);
    context.lineTo(width * 0.25, 8);
    context.stroke();
    context.restore();
  }
}

function drawEmberParticles(
  context: CanvasRenderingContext2D,
  world: GameWorld,
  count: number,
  motion: number,
) {
  for (let index = 0; index < count; index++) {
    const x = noise(world.seed, index, 109) * world.width;
    const y = wrap(
      noise(world.seed, index, 113) * world.height - world.elapsedMs * 0.022 * motion,
      world.height + 20,
    ) - 10;
    const radius = 1 + noise(world.seed, index, 127) * 3;
    context.fillStyle = `rgba(255,179,79,${0.25 + noise(world.seed, index, 131) * 0.65})`;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }
}

function drawShadowParticles(
  context: CanvasRenderingContext2D,
  world: GameWorld,
  count: number,
  motion: number,
) {
  for (let index = 0; index < count; index++) {
    const radius = 20 + noise(world.seed, index, 137) * 70;
    const x = noise(world.seed, index, 139) * world.width;
    const y = wrap(
      noise(world.seed, index, 149) * world.height + world.elapsedMs * 0.004 * motion,
      world.height + radius * 2,
    ) - radius;
    const shadow = context.createRadialGradient(x, y, 0, x, y, radius);
    shadow.addColorStop(0, "rgba(0,0,8,0.24)");
    shadow.addColorStop(1, "rgba(0,0,8,0)");
    context.fillStyle = shadow;
    context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
}

function drawArenaParticles(
  context: CanvasRenderingContext2D,
  world: GameWorld,
  count: number,
  motion: number,
) {
  context.strokeStyle = "rgba(255,107,61,0.18)";
  context.lineWidth = 1;
  const pulse = motion === 0 ? 0 : Math.sin(world.elapsedMs / 500) * 12;
  for (let index = 0; index < count; index++) {
    const radius = 70 + index * 50 + pulse;
    context.beginPath();
    context.arc(world.width / 2, world.height / 2, radius, 0, Math.PI * 2);
    context.stroke();
  }
}

function drawParticles(
  context: CanvasRenderingContext2D,
  world: GameWorld,
  reducedMotion: boolean,
) {
  const particleStyle = SECTOR_BALANCE[world.sector].particleStyle;
  const count = reducedMotion ? 16 : 52;
  const motion = reducedMotion ? 0 : 1;
  if (particleStyle === "stars") drawStarParticles(context, world, count, motion);
  else if (particleStyle === "mist") drawMistParticles(context, world, reducedMotion ? 4 : 11, motion);
  else if (particleStyle === "rocks") drawRockParticles(context, world, count / 2, motion);
  else if (particleStyle === "crystals") drawCrystalParticles(context, world, count / 2, motion);
  else if (particleStyle === "ions") drawIonParticles(context, world, count / 2, motion);
  else if (particleStyle === "wreckage") drawWreckageParticles(context, world, count / 3, motion);
  else if (particleStyle === "embers") drawEmberParticles(context, world, count, motion);
  else if (particleStyle === "shadows") drawShadowParticles(context, world, reducedMotion ? 5 : 13, motion);
  else drawArenaParticles(context, world, reducedMotion ? 3 : 7, motion);
}

function drawSectorHazard(
  context: CanvasRenderingContext2D,
  world: GameWorld,
  reducedMotion: boolean,
) {
  const hazard = SECTOR_BALANCE[world.sector].hazard;
  const motion = reducedMotion ? 0 : 1;
  if (hazard === "visibility-pulse") {
    const alpha = reducedMotion ? 0.12 : 0.09 + (Math.sin(world.elapsedMs / 900) + 1) * 0.045;
    context.fillStyle = `rgba(197,140,255,${alpha})`;
    context.fillRect(0, 0, world.width, world.height);
  } else if (hazard === "debris-lanes") {
    context.setLineDash([12, 18]);
    context.strokeStyle = "rgba(242,182,141,0.16)";
    for (let lane = 1; lane < 7; lane++) {
      const x = (lane / 7) * world.width;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, world.height);
      context.stroke();
    }
    context.setLineDash([]);
  } else if (hazard === "cryo-drift") {
    const frost = context.createLinearGradient(0, 0, world.width, 0);
    frost.addColorStop(0, "rgba(168,232,255,0.2)");
    frost.addColorStop(0.15, "rgba(168,232,255,0)");
    frost.addColorStop(0.85, "rgba(168,232,255,0)");
    frost.addColorStop(1, "rgba(168,232,255,0.2)");
    context.fillStyle = frost;
    context.fillRect(0, 0, world.width, world.height);
  } else if (hazard === "ion-pulse") {
    const alpha = reducedMotion ? 0.08 : Math.max(0, Math.sin(world.elapsedMs / 180)) * 0.08;
    context.fillStyle = `rgba(154,255,107,${alpha})`;
    context.fillRect(0, 0, world.width, world.height);
  } else if (hazard === "minefield") {
    context.strokeStyle = "rgba(255,122,157,0.2)";
    for (let index = 0; index < 9; index++) {
      const x = noise(world.seed, index, 151) * world.width;
      const y = noise(world.seed, index, 157) * world.height;
      context.beginPath();
      context.arc(x, y, 8, 0, Math.PI * 2);
      context.moveTo(x - 12, y);
      context.lineTo(x + 12, y);
      context.moveTo(x, y - 12);
      context.lineTo(x, y + 12);
      context.stroke();
    }
  } else if (hazard === "solar-flare") {
    const flareX = world.width * (0.2 + 0.6 * noise(world.seed, Math.floor(world.elapsedMs / 4_600), 163));
    const flare = context.createLinearGradient(flareX - 80, 0, flareX + 80, 0);
    flare.addColorStop(0, "rgba(255,179,79,0)");
    flare.addColorStop(0.5, `rgba(255,179,79,${motion ? 0.14 : 0.08})`);
    flare.addColorStop(1, "rgba(255,179,79,0)");
    context.fillStyle = flare;
    context.fillRect(flareX - 80, 0, 160, world.height);
  } else if (hazard === "limited-light") {
    const vignette = context.createRadialGradient(
      world.player.x,
      world.player.y,
      90,
      world.player.x,
      world.player.y,
      330,
    );
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, "rgba(0,0,8,0.64)");
    context.fillStyle = vignette;
    context.fillRect(0, 0, world.width, world.height);
  } else if (hazard === "boss-arena") {
    context.strokeStyle = "rgba(255,107,61,0.45)";
    context.lineWidth = 3;
    context.strokeRect(10, 10, world.width - 20, world.height - 20);
  }
}

function drawTelegraphs(
  context: CanvasRenderingContext2D,
  world: GameWorld,
  reducedMotion: boolean,
) {
  if (world.wavePhase !== "telegraph" && world.wavePhase !== "combat") return;
  const pulse = reducedMotion ? 0.7 : 0.45 + (Math.sin(world.elapsedMs / 110) + 1) * 0.25;
  context.strokeStyle = `rgba(255,107,61,${pulse})`;
  context.lineWidth = 2;
  for (const spawn of world.wavePlan.spawns) {
    if (
      world.waveElapsedMs < spawn.telegraphAtMs ||
      world.waveElapsedMs >= spawn.spawnAtMs
    ) {
      continue;
    }
    const x = (world.width / 7) * (spawn.lane + 0.5);
    context.beginPath();
    context.moveTo(x - 14, 12);
    context.lineTo(x, 32);
    context.lineTo(x + 14, 12);
    context.stroke();
  }
  const boss = world.wavePlan.boss;
  if (
    boss &&
    world.waveElapsedMs >= boss.telegraphAtMs &&
    world.waveElapsedMs < boss.spawnAtMs
  ) {
    context.strokeStyle = `rgba(255,107,61,${pulse})`;
    context.lineWidth = 4;
    context.beginPath();
    context.arc(world.width / 2, 88, 58, 0, Math.PI * 2);
    context.stroke();
  }
}

function drawHealthBar(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  ratio: number,
  color: string,
) {
  const normalized = clamp(ratio, 0, 1);
  context.fillStyle = "rgba(2,8,14,0.78)";
  context.fillRect(x - width / 2 - 1, y - 1, width + 2, 6);
  context.fillStyle = color;
  context.fillRect(x - width / 2, y, width * normalized, 4);
}

function drawProjectile(
  context: CanvasRenderingContext2D,
  projectile: ProjectileRuntime,
) {
  context.save();
  context.translate(projectile.x, projectile.y);
  context.strokeStyle = projectile.color;
  context.fillStyle = projectile.color;
  context.lineCap = "round";

  if (projectile.kind === "laser") {
    context.globalAlpha = 0.92;
    context.lineWidth = Math.max(2, projectile.radius * 1.25);
    context.beginPath();
    context.moveTo(0, projectile.owner === "enemy" ? -20 : 28);
    context.lineTo(0, projectile.owner === "enemy" ? 24 : -38);
    context.stroke();
  } else if (projectile.kind === "missile") {
    context.rotate(Math.atan2(projectile.vy, projectile.vx) + Math.PI / 2);
    context.beginPath();
    context.moveTo(0, -10);
    context.lineTo(6, 7);
    context.lineTo(0, 4);
    context.lineTo(-6, 7);
    context.closePath();
    context.fill();
    context.strokeStyle = "rgba(255,211,122,0.65)";
    context.beginPath();
    context.moveTo(-3, 8);
    context.lineTo(0, 16);
    context.lineTo(3, 8);
    context.stroke();
  } else if (projectile.kind === "orb") {
    context.globalAlpha = 0.28;
    context.beginPath();
    context.arc(0, 0, projectile.radius * 2.2, 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = 1;
    context.beginPath();
    context.arc(0, 0, projectile.radius, 0, Math.PI * 2);
    context.fill();
  } else {
    context.lineWidth = Math.max(2, projectile.radius * 1.1);
    context.beginPath();
    context.moveTo(0, projectile.owner === "enemy" ? -5 : 8);
    context.lineTo(0, projectile.owner === "enemy" ? 9 : -14);
    context.stroke();
  }
  context.restore();
}

function drawPickup(
  context: CanvasRenderingContext2D,
  pickup: PickupRuntime,
  world: GameWorld,
  reducedMotion: boolean,
) {
  const rotation = reducedMotion ? 0 : world.elapsedMs * 0.0018;
  const color = pickup.kind === "energy" ? "#68e4ff" : "#d7f55a";
  context.save();
  context.translate(pickup.x, pickup.y);
  context.rotate(rotation);
  context.strokeStyle = color;
  context.fillStyle = `${color}35`;
  context.lineWidth = 2;
  polygon(context, 0, 0, pickup.radius, pickup.kind === "energy" ? 4 : 6, Math.PI / 4);
  context.fill();
  context.stroke();
  context.rotate(-rotation);
  context.fillStyle = color;
  context.beginPath();
  context.arc(0, 0, 3.5, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function asteroidPath(
  context: CanvasRenderingContext2D,
  enemy: EnemyRuntime,
) {
  polygon(
    context,
    0,
    0,
    enemy.radius,
    enemy.archetype === "splitter-asteroid" ? 9 : 7,
    enemy.rotation,
    0.2,
  );
}

function drawDrone(
  context: CanvasRenderingContext2D,
  enemy: EnemyRuntime,
  color: string,
) {
  const radius = enemy.radius;
  context.strokeStyle = color;
  context.fillStyle = `${color}2f`;
  context.lineWidth = 2;

  if (enemy.archetype === "scout-drone") {
    context.beginPath();
    context.moveTo(0, radius);
    context.lineTo(radius, -radius * 0.45);
    context.lineTo(0, -radius * 0.1);
    context.lineTo(-radius, -radius * 0.45);
    context.closePath();
  } else if (enemy.archetype === "gunner-drone") {
    polygon(context, 0, 0, radius, 6, Math.PI / 6, 0.12);
  } else if (enemy.archetype === "hunter-drone") {
    context.beginPath();
    context.moveTo(0, radius);
    context.lineTo(radius * 0.75, -radius * 0.75);
    context.lineTo(0, -radius * 0.35);
    context.lineTo(-radius * 0.75, -radius * 0.75);
    context.closePath();
  } else {
    context.beginPath();
    context.arc(0, 0, radius * 0.72, 0, Math.PI * 2);
    context.moveTo(-radius, 0);
    context.lineTo(radius, 0);
    context.moveTo(0, -radius);
    context.lineTo(0, radius);
  }
  context.fill();
  context.stroke();

  context.fillStyle = enemy.archetype === "support-drone" ? "#95ffad" : "#ff6b78";
  context.beginPath();
  context.arc(0, 0, Math.max(3, radius * 0.2), 0, Math.PI * 2);
  context.fill();
}

function drawEnemy(
  context: CanvasRenderingContext2D,
  enemy: EnemyRuntime,
  world: GameWorld,
  reducedMotion: boolean,
) {
  const stunned = enemy.stunnedUntilMs > world.elapsedMs;
  const buffed = enemy.buffedUntilMs > world.elapsedMs;
  const accent = enemy.elite ? "#ffd36a" : stunned ? "#68e4ff" : "#ff9270";
  context.save();
  context.translate(enemy.x, enemy.y);
  if (!reducedMotion) context.rotate(enemy.rotation);
  context.lineWidth = enemy.elite ? 3 : 2;
  context.strokeStyle = accent;
  context.fillStyle = buffed ? "rgba(149,255,173,0.24)" : "rgba(255,146,112,0.18)";

  if (
    enemy.archetype === "swift-asteroid" ||
    enemy.archetype === "splitter-asteroid" ||
    enemy.archetype === "armored-asteroid"
  ) {
    asteroidPath(context, enemy);
    context.fill();
    context.stroke();
    if (enemy.archetype === "armored-asteroid") {
      context.strokeStyle = "rgba(218,235,255,0.72)";
      context.beginPath();
      context.arc(0, 0, enemy.radius * 0.58, -2.7, -0.35);
      context.stroke();
    } else if (enemy.archetype === "splitter-asteroid") {
      context.beginPath();
      context.moveTo(-enemy.radius * 0.5, -enemy.radius * 0.55);
      context.lineTo(enemy.radius * 0.05, -enemy.radius * 0.08);
      context.lineTo(-enemy.radius * 0.2, enemy.radius * 0.65);
      context.stroke();
    }
  } else if (enemy.archetype === "comet") {
    context.strokeStyle = "rgba(255,179,79,0.55)";
    context.lineWidth = enemy.radius * 0.7;
    context.beginPath();
    context.moveTo(0, -enemy.radius * 0.2);
    context.lineTo(-enemy.vx * 0.14, -enemy.vy * 0.14);
    context.stroke();
    context.fillStyle = "#fff0b0";
    context.beginPath();
    context.arc(0, 0, enemy.radius * 0.65, 0, Math.PI * 2);
    context.fill();
  } else if (enemy.archetype === "mine") {
    for (let point = 0; point < 8; point++) {
      const angle = (point / 8) * Math.PI * 2;
      context.beginPath();
      context.moveTo(Math.cos(angle) * enemy.radius * 0.65, Math.sin(angle) * enemy.radius * 0.65);
      context.lineTo(Math.cos(angle) * enemy.radius * 1.25, Math.sin(angle) * enemy.radius * 1.25);
      context.stroke();
    }
    context.beginPath();
    context.arc(0, 0, enemy.radius * 0.65, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  } else if (enemy.archetype === "debris") {
    context.fillStyle = "rgba(212,179,143,0.28)";
    context.strokeStyle = "#d4b38f";
    polygon(context, 0, 0, enemy.radius, 5, 0, 0.34);
    context.fill();
    context.stroke();
  } else {
    drawDrone(context, enemy, accent);
  }

  if (enemy.elite) {
    context.strokeStyle = "rgba(255,211,106,0.62)";
    context.lineWidth = 1;
    context.setLineDash([4, 5]);
    context.beginPath();
    context.arc(0, 0, enemy.radius + 7, 0, Math.PI * 2);
    context.stroke();
    context.setLineDash([]);
  }
  context.restore();

  if (enemy.maxHealth > 1 && enemy.health < enemy.maxHealth) {
    drawHealthBar(
      context,
      enemy.x,
      enemy.y - enemy.radius - 10,
      enemy.radius * 1.7,
      enemy.health / enemy.maxHealth,
      enemy.elite ? "#ffd36a" : "#ff9270",
    );
  }
}

function drawBoss(
  context: CanvasRenderingContext2D,
  boss: BossRuntime,
  world: GameWorld,
  reducedMotion: boolean,
) {
  const rotation = reducedMotion ? 0 : boss.rotation;
  const stunned = boss.stunnedUntilMs > world.elapsedMs;
  const color = stunned ? "#68e4ff" : "#ff6b3d";
  const radius = boss.radius;
  context.save();
  context.translate(boss.x, boss.y);
  context.rotate(rotation);
  context.strokeStyle = color;
  context.fillStyle = "rgba(255,107,61,0.2)";
  context.lineWidth = 3;

  if (boss.bossId === "sentinel-array") {
    polygon(context, 0, 0, radius * 0.58, 8, Math.PI / 8, 0.08);
    context.fill();
    context.stroke();
    for (let node = 0; node < 4; node++) {
      const angle = (node / 4) * Math.PI * 2;
      const x = Math.cos(angle) * radius * 0.82;
      const y = Math.sin(angle) * radius * 0.82;
      context.beginPath();
      context.arc(x, y, radius * 0.16, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
  } else if (boss.bossId === "comet-leviathan") {
    for (let segment = 4; segment >= 0; segment--) {
      const offset = segment * radius * 0.32;
      const segmentRadius = radius * (0.56 - segment * 0.07);
      context.beginPath();
      context.ellipse(0, -offset, segmentRadius, segmentRadius * 0.72, 0, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
    context.fillStyle = "#ffd07a";
    context.beginPath();
    context.arc(-radius * 0.2, radius * 0.08, 5, 0, Math.PI * 2);
    context.arc(radius * 0.2, radius * 0.08, 5, 0, Math.PI * 2);
    context.fill();
  } else {
    context.beginPath();
    context.moveTo(0, radius * 0.86);
    context.lineTo(radius * 0.82, radius * 0.24);
    context.lineTo(radius * 0.6, -radius * 0.68);
    context.lineTo(radius * 0.16, -radius * 0.42);
    context.lineTo(0, -radius);
    context.lineTo(-radius * 0.16, -radius * 0.42);
    context.lineTo(-radius * 0.6, -radius * 0.68);
    context.lineTo(-radius * 0.82, radius * 0.24);
    context.closePath();
    context.fill();
    context.stroke();
    context.fillStyle = "#ff7897";
    context.fillRect(-radius * 0.34, -6, radius * 0.68, 12);
  }

  context.strokeStyle = `${color}88`;
  context.lineWidth = 2;
  context.setLineDash([8, 8]);
  context.beginPath();
  context.arc(0, 0, radius + 12 + boss.phase * 3, 0, Math.PI * 2);
  context.stroke();
  context.setLineDash([]);
  context.restore();

  const barWidth = Math.min(420, world.width * 0.58);
  drawHealthBar(
    context,
    world.width / 2,
    24,
    barWidth,
    boss.health / boss.maxHealth,
    color,
  );
  context.fillStyle = "rgba(255,255,255,0.72)";
  for (let phase = 1; phase <= boss.phase; phase++) {
    context.fillRect(world.width / 2 - barWidth / 2 + (phase - 1) * 10, 31, 6, 2);
  }
}

function drawPlayer(
  context: CanvasRenderingContext2D,
  world: GameWorld,
  reducedMotion: boolean,
) {
  const player = world.player;
  const invulnerable = player.invulnerableUntilMs > world.elapsedMs;
  const shielded = player.shield > 0;
  context.save();
  context.translate(player.x, player.y);

  if (!reducedMotion) {
    const flame = 13 + Math.sin(world.elapsedMs / 45) * 4;
    const flameGradient = context.createLinearGradient(0, 12, 0, 12 + flame);
    flameGradient.addColorStop(0, "rgba(104,228,255,0.9)");
    flameGradient.addColorStop(1, "rgba(104,228,255,0)");
    context.fillStyle = flameGradient;
    context.beginPath();
    context.moveTo(-7, 12);
    context.lineTo(0, 12 + flame);
    context.lineTo(7, 12);
    context.closePath();
    context.fill();
  }

  context.fillStyle = "rgba(86,215,191,0.34)";
  context.strokeStyle = invulnerable ? "#fff49a" : "#65f1d5";
  context.lineWidth = 2.5;
  context.beginPath();
  context.moveTo(0, -player.radius * 1.25);
  context.lineTo(player.radius * 0.95, player.radius);
  context.lineTo(0, player.radius * 0.55);
  context.lineTo(-player.radius * 0.95, player.radius);
  context.closePath();
  context.fill();
  context.stroke();
  context.fillStyle = "#bffcff";
  context.beginPath();
  context.ellipse(0, -3, 5, 9, 0, 0, Math.PI * 2);
  context.fill();

  if (shielded || invulnerable) {
    const shieldAlpha = invulnerable ? 0.85 : 0.3 + 0.45 * (player.shield / player.maxShield);
    context.strokeStyle = invulnerable ? `rgba(255,244,154,${shieldAlpha})` : `rgba(104,228,255,${shieldAlpha})`;
    context.lineWidth = invulnerable ? 4 : 2;
    context.beginPath();
    context.arc(0, 0, player.radius + 8, 0, Math.PI * 2);
    context.stroke();
  }
  context.restore();

  const activeDrone =
    world.powerStates.drone?.activeUntilMs !== undefined &&
    world.powerStates.drone.activeUntilMs > world.elapsedMs;
  const droneCount = Math.max(
    activeDrone ? 1 : 0,
    Math.min(2, world.upgradeStacks["escort-drone"] ?? 0),
  );
  for (let index = 0; index < droneCount; index++) {
    const angle =
      (reducedMotion ? -0.7 : world.elapsedMs * 0.0025) +
      (index * Math.PI * 2) / droneCount;
    const x = player.x + Math.cos(angle) * 42;
    const y = player.y + Math.sin(angle) * 22;
    context.fillStyle = "rgba(215,245,90,0.3)";
    context.strokeStyle = "#d7f55a";
    context.beginPath();
    context.moveTo(x, y - 8);
    context.lineTo(x + 8, y + 6);
    context.lineTo(x - 8, y + 6);
    context.closePath();
    context.fill();
    context.stroke();
  }
}

function drawEffect(
  context: CanvasRenderingContext2D,
  effect: HitEffectRuntime,
  world: GameWorld,
  reducedMotion: boolean,
) {
  const duration = Math.max(1, effect.expiresAtMs - effect.createdAtMs);
  const progress = clamp((world.elapsedMs - effect.createdAtMs) / duration, 0, 1);
  const radius = reducedMotion ? effect.radius : effect.radius * (0.35 + progress * 0.9);
  context.save();
  context.globalAlpha = 1 - progress;
  context.strokeStyle = effect.color;
  context.fillStyle = `${effect.color}2e`;
  context.lineWidth = effect.kind === "explosion" || effect.kind === "emp" ? 4 : 2;

  if (effect.kind === "hit") {
    for (let ray = 0; ray < 5; ray++) {
      const angle = (ray / 5) * Math.PI * 2;
      context.beginPath();
      context.moveTo(effect.x + Math.cos(angle) * 3, effect.y + Math.sin(angle) * 3);
      context.lineTo(effect.x + Math.cos(angle) * radius, effect.y + Math.sin(angle) * radius);
      context.stroke();
    }
  } else if (effect.kind === "dash") {
    context.beginPath();
    context.ellipse(effect.x, effect.y, radius * 1.8, radius * 0.5, 0, 0, Math.PI * 2);
    context.stroke();
  } else {
    context.beginPath();
    context.arc(effect.x, effect.y, radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
  context.restore();
}

function drawPhaseWash(
  context: CanvasRenderingContext2D,
  world: GameWorld,
) {
  if (world.wavePhase === "rest") {
    context.fillStyle = "rgba(86,215,191,0.045)";
    context.fillRect(0, 0, world.width, world.height);
  } else if (world.wavePhase === "telegraph") {
    context.fillStyle = "rgba(255,107,61,0.035)";
    context.fillRect(0, 0, world.width, world.height);
  }
}

/**
 * Draws one immutable-looking projection of the mutable simulation. The renderer
 * never advances RNG or changes the world, so drawing frequency cannot affect a
 * run's deterministic outcome.
 */
export function renderGameWorld(
  context: CanvasRenderingContext2D,
  world: GameWorld,
  options: RenderGameWorldOptions = {},
) {
  const reducedMotion = options.reducedMotion ?? false;
  const shakeEnabled = (options.screenShake ?? true) && !reducedMotion;
  const shakeAmount = shakeEnabled
    ? clamp(world.screenShake * (options.shakeScale ?? 1), 0, 18)
    : 0;

  context.save();
  context.clearRect(0, 0, world.width, world.height);
  if (shakeAmount > 0) {
    context.translate(
      Math.sin(world.elapsedMs * 0.071) * shakeAmount,
      Math.cos(world.elapsedMs * 0.053) * shakeAmount,
    );
  }

  drawBackground(context, world);
  drawParticles(context, world, reducedMotion);
  drawSectorHazard(context, world, reducedMotion);
  drawPhaseWash(context, world);
  drawTelegraphs(context, world, reducedMotion);

  for (const effect of world.effects) {
    if (effect.kind === "spawn" || effect.kind === "dash") {
      drawEffect(context, effect, world, reducedMotion);
    }
  }
  for (const pickup of world.pickups) {
    drawPickup(context, pickup, world, reducedMotion);
  }
  for (const projectile of world.playerProjectiles) {
    drawProjectile(context, projectile);
  }
  for (const projectile of world.enemyProjectiles) {
    drawProjectile(context, projectile);
  }
  for (const enemy of world.enemies) {
    drawEnemy(context, enemy, world, reducedMotion);
  }
  if (world.boss) drawBoss(context, world.boss, world, reducedMotion);
  drawPlayer(context, world, reducedMotion);
  for (const effect of world.effects) {
    if (effect.kind !== "spawn" && effect.kind !== "dash") {
      drawEffect(context, effect, world, reducedMotion);
    }
  }
  context.restore();
}
