/**
 * 原版 MC 1.8.9 玩家物理的 TypeScript 复刻，用于 Simulation 检查的全量预测。
 *
 * 对照 net.minecraft.entity.EntityLivingBase / EntityPlayer / Entity：
 *   onLivingUpdate → moveEntityWithHeading(travel) → moveEntity(move) → moveFlying
 *
 * 与 Vanilla 的差别（代理拿不到客户端的完整世界，只能近似）：
 *   - 方块碰撞盒统一按"整方块"处理（不做楼梯/台阶/栅栏的精细形状）
 *   - 忽略 ladder / 水的精细物理，水面按 0.02 浮力近似
 *   - 未知方块（缺区块数据）直接让整个预测放弃，避免误判
 */
import { Vec3, BlockUtils, type WorldModel } from "../core.js";

/** 岩浆/水/空气等不参与碰撞的方块 id */
const PASSABLE = new Set<number>([
  0, 8, 9, 10, 11, 26, 27, 28, 30, 31, 32, 37, 38, 39, 40, 50, 51, 55, 59, 63, 64, 65, 66, 68, 69, 70, 71, 72, 75, 76,
  77, 78, 83, 84, 85, 90, 92, 93, 94, 96, 101, 102, 104, 105, 106, 107, 111, 113, 115, 116, 117, 118, 119, 120, 127,
  131, 132, 138, 139, 140, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 154, 157, 160, 161, 162, 163, 164, 165,
  166, 167, 168, 169, 170, 171, 175, 176, 177, 178, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193,
  194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211,
]);

/** 滑度（原版 Block.slipperiness） */
function slipperinessOf(id: number): number {
  switch (id) {
    case 79: // ice
    case 174: // packed ice
      return 0.98;
    case 165: // slime block
      return 0.8;
    case 26: // bed
      return 0.8;
    default:
      return 0.6;
  }
}

/* ------------------------------------------------------------------ AABB */

export class AABB {
  constructor(
    public minX: number,
    public minY: number,
    public minZ: number,
    public maxX: number,
    public maxY: number,
    public maxZ: number
  ) {}

  static fromPlayer(pos: Vec3, width = 0.6, height = 1.8): AABB {
    const half = width / 2;
    return new AABB(pos.x - half, pos.y, pos.z - half, pos.x + half, pos.y + height, pos.z + half);
  }

  offset(dx: number, dy: number, dz: number): AABB {
    return new AABB(this.minX + dx, this.minY + dy, this.minZ + dz, this.maxX + dx, this.maxY + dy, this.maxZ + dz);
  }

  expand(dx: number, dy: number, dz: number): AABB {
    return new AABB(
      Math.min(this.minX, this.minX + dx),
      Math.min(this.minY, this.minY + dy),
      Math.min(this.minZ, this.minZ + dz),
      Math.max(this.maxX, this.maxX + dx),
      Math.max(this.maxY, this.maxY + dy),
      Math.max(this.maxZ, this.maxZ + dz)
    );
  }

  intersects(other: AABB): boolean {
    return (
      other.maxX > this.minX && other.minX < this.maxX &&
      other.maxY > this.minY && other.minY < this.maxY &&
      other.maxZ > this.minZ && other.minZ < this.maxZ
    );
  }

  /** 原版 AxisAlignedBB.calculateYOffset */
  static clipY(collider: AABB, moving: AABB, offsetY: number): number {
    if (collider.maxX <= moving.minX || collider.minX >= moving.maxX) return offsetY;
    if (collider.maxZ <= moving.minZ || collider.minZ >= moving.maxZ) return offsetY;
    if (offsetY > 0 && collider.maxY <= moving.minY) {
      const d = moving.minY - collider.maxY;
      if (d < offsetY) offsetY = d;
    }
    if (offsetY < 0 && collider.minY >= moving.maxY) {
      const d = moving.maxY - collider.minY;
      if (d > offsetY) offsetY = d;
    }
    return offsetY;
  }

  static clipX(collider: AABB, moving: AABB, offsetX: number): number {
    if (collider.maxY <= moving.minY || collider.minY >= moving.maxY) return offsetX;
    if (collider.maxZ <= moving.minZ || collider.minZ >= moving.maxZ) return offsetX;
    if (offsetX > 0 && collider.maxX <= moving.minX) {
      const d = moving.minX - collider.maxX;
      if (d < offsetX) offsetX = d;
    }
    if (offsetX < 0 && collider.minX >= moving.maxX) {
      const d = moving.maxX - collider.minX;
      if (d > offsetX) offsetX = d;
    }
    return offsetX;
  }

  static clipZ(collider: AABB, moving: AABB, offsetZ: number): number {
    if (collider.maxX <= moving.minX || collider.minX >= moving.maxX) return offsetZ;
    if (collider.maxY <= moving.minY || collider.minY >= moving.maxY) return offsetZ;
    if (offsetZ > 0 && collider.maxZ <= moving.minZ) {
      const d = moving.minZ - collider.maxZ;
      if (d < offsetZ) offsetZ = d;
    }
    if (offsetZ < 0 && collider.minZ >= moving.maxZ) {
      const d = moving.maxZ - collider.minZ;
      if (d > offsetZ) offsetZ = d;
    }
    return offsetZ;
  }

  static fromBlock(x: number, y: number, z: number): AABB {
    return new AABB(x, y, z, x + 1, y + 1, z + 1);
  }
}

/* -------------------------------------------------------------- 碰撞世界 */

export class CollisionWorld {
  constructor(private readonly world: WorldModel) {}

  /** 返回 null 表示区块数据缺失，调用方必须放弃本次预测 */
  isSolidAt(x: number, y: number, z: number): boolean | null {
    const block = this.world.getBlock(x, y, z);
    if (!block) return this.world.isChunkLoadedAt(x, z) ? false : null;
    if (block.id === 0) return false;
    return !PASSABLE.has(block.id);
  }

  slipperiness(x: number, y: number, z: number): number {
    const block = this.world.getBlock(x, y, z);
    return block ? slipperinessOf(block.id) : 0.6;
  }

  /** 收集与 AABB 相交的方块碰撞盒；遇到未知区块返回 null */
  collisionBoxes(box: AABB): AABB[] | null {
    const boxes: AABB[] = [];
    const minX = Math.floor(box.minX - 1);
    const maxX = Math.floor(box.maxX + 1);
    const minY = Math.floor(box.minY - 1);
    const maxY = Math.floor(box.maxY + 1);
    const minZ = Math.floor(box.minZ - 1);
    const maxZ = Math.floor(box.maxZ + 1);

    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        if (!this.world.isChunkLoadedAt(x, z)) return null;
        for (let y = minY; y <= maxY; y++) {
          if (y < 0 || y > 255) continue;
          const solid = this.isSolidAt(x, y, z);
          if (solid === null) return null;
          if (solid) boxes.push(AABB.fromBlock(x, y, z));
        }
      }
    }
    return boxes;
  }

  /** 玩家所在位置是否卡在方块里（原版 isOpenBlockSpace 的近似） */
  isFreeSpace(box: AABB): boolean | null {
    const boxes = this.collisionBoxes(box);
    if (!boxes) return null;
    return !boxes.some((b) => b.intersects(box));
  }
}

/* -------------------------------------------------------------- 物理实体 */

export interface MovementInputState {
  moveForward: number;
  moveStrafe: number;
  jump: boolean;
  sneak: boolean;
}

export interface PhysicsOptions {
  /** 基础移动速度属性（原版 0.1） */
  movementSpeed: number;
  /** 速度药水等级，-1 = 没有 */
  speedAmplifier: number;
  /** 跳跃提升等级，-1 = 没有 */
  jumpAmplifier: number;
  /** 是否疾跑 */
  sprinting: boolean;
  /** 是否使用物品（会 ×0.2 减速） */
  usingItem: boolean;
}

export class SimulatedPlayer {
  public pos: Vec3;
  public motion: Vec3;
  public onGround: boolean;
  public yaw: number;
  public pitch: number;
  public input: MovementInputState;
  public sprinting: boolean;
  public usingItem: boolean;
  public movementSpeed: number;
  public speedAmplifier: number;
  public jumpAmplifier: number;
  public stepHeight = 0.6;
  public width = 0.6;
  public height = 1.8;
  public jumpTicks = 0;
  public fallDistance = 0;
  /** 本次预测中世界数据是否完整；false = 结果不可信 */
  public reliable = true;

  constructor(
    public readonly world: CollisionWorld,
    pos: Vec3,
    motion: Vec3,
    onGround: boolean,
    yaw: number,
    pitch: number,
    input: MovementInputState,
    options: PhysicsOptions
  ) {
    this.pos = pos.clone();
    this.motion = motion.clone();
    this.onGround = onGround;
    this.yaw = yaw;
    this.pitch = pitch;
    this.input = { ...input };
    this.sprinting = options.sprinting;
    this.usingItem = options.usingItem;
    this.movementSpeed = options.movementSpeed;
    this.speedAmplifier = options.speedAmplifier;
    this.jumpAmplifier = options.jumpAmplifier;
  }

  clip(pos?: Vec3): SimulatedPlayer {
    const copy = new SimulatedPlayer(
      this.world,
      pos ?? this.pos,
      this.motion.clone(),
      this.onGround,
      this.yaw,
      this.pitch,
      this.input,
      {
        movementSpeed: this.movementSpeed,
        speedAmplifier: this.speedAmplifier,
        jumpAmplifier: this.jumpAmplifier,
        sprinting: this.sprinting,
        usingItem: this.usingItem,
      }
    );
    copy.jumpTicks = this.jumpTicks;
    copy.fallDistance = this.fallDistance;
    copy.reliable = this.reliable;
    return copy;
  }

  /** 原版 EntityLivingBase.getAIMoveSpeed */
  getAIMoveSpeed(): number {
    let speed = this.movementSpeed;
    if (this.sprinting) speed *= 1.3;
    if (this.speedAmplifier >= 0) speed *= 1 + 0.2 * this.speedAmplifier;
    return speed;
  }

  /** 原版 onLivingUpdate 的移动部分 */
  onUpdate(): void {
    let forward = this.input.moveForward;
    let strafe = this.input.moveStrafe;
    if (this.usingItem) {
      forward *= 0.2;
      strafe *= 0.2;
    }

    if (this.input.jump) {
      if (this.onGround && this.jumpTicks === 0) {
        this.jump();
        this.jumpTicks = 10;
      }
    } else {
      this.jumpTicks = 0;
    }

    forward *= 0.98;
    strafe *= 0.98;
    this.travel(strafe, forward);
  }

  /** 原版 jump() */
  jump(): void {
    this.motion.y = 0.42 + (this.jumpAmplifier >= 0 ? 0.1 * (this.jumpAmplifier + 1) : 0);
    if (this.sprinting) {
      const f = (this.yaw * Math.PI) / 180;
      this.motion.x -= Math.sin(f) * 0.2;
      this.motion.z += Math.cos(f) * 0.2;
    }
  }

  /** 原版 moveEntityWithHeading / travel */
  travel(strafe: number, forward: number): void {
    const blockBelowX = Math.floor(this.pos.x);
    const blockBelowY = Math.floor(this.pos.y - 1);
    const blockBelowZ = Math.floor(this.pos.z);

    let friction = 0.91;
    if (this.onGround) {
      const slipperiness = this.world.slipperiness(blockBelowX, blockBelowY, blockBelowZ);
      friction = slipperiness * 0.91;
    }

    const accel = 0.16277136 / (friction * friction * friction);
    const speed = this.onGround ? this.getAIMoveSpeed() * accel : 0.02;
    this.moveFlying(strafe, forward, speed);

    let frictionAfter = 0.91;
    if (this.onGround) {
      frictionAfter = this.world.slipperiness(blockBelowX, blockBelowY, blockBelowZ) * 0.91;
    }

    this.motion.y -= 0.08;
    this.motion.y *= 0.98;
    this.move(this.motion.x, this.motion.y, this.motion.z);
    this.motion.x *= frictionAfter;
    this.motion.y *= 0.98;
    this.motion.z *= frictionAfter;
  }

  /** 原版 moveFlying：把输入按朝向转成运动 */
  moveFlying(strafe: number, forward: number, speed: number): void {
    const length = Math.hypot(strafe, forward);
    if (length < 0.01) return;
    const normStrafe = strafe / length;
    const normForward = forward / length;
    const rad = (this.yaw * Math.PI) / 180;
    const sin = Math.sin(rad);
    const cos = Math.cos(rad);
    this.motion.x += normStrafe * cos * speed - normForward * sin * speed;
    this.motion.z += normForward * cos * speed + normStrafe * sin * speed;
  }

  /** 原版 Entity.move —— 分轴解算碰撞，带 0.6 格台阶 */
  move(dx: number, dy: number, dz: number): void {
    const startBox = AABB.fromPlayer(this.pos, this.width, this.height);
    const swept = startBox.expand(dx, dy, dz);
    const boxes = this.world.collisionBoxes(swept);
    if (!boxes) {
      this.reliable = false;
      return;
    }

    let box = startBox;
    let ny = dy;
    for (const b of boxes) ny = AABB.clipY(b, box, ny);
    box = box.offset(0, ny, 0);
    const hitGround = ny !== dy && ny < 0;

    let nx = dx;
    for (const b of boxes) nx = AABB.clipX(b, box, nx);
    box = box.offset(nx, 0, 0);

    let nz = dz;
    for (const b of boxes) nz = AABB.clipZ(b, box, nz);
    box = box.offset(0, 0, nz);

    // 台阶：水平被挡住时尝试抬高 0.6 再移动
    if (this.stepHeight > 0 && hitGround && (nx !== dx || nz !== dz)) {
      const stepped = this.tryStep(startBox, dx, dz);
      if (stepped) {
        this.applyBox(stepped);
        this.applyMotion(nx, ny, nz, hitGround);
        return;
      }
    }

    this.applyBox(box);
    this.applyMotion(nx, ny, nz, hitGround);
  }

  private tryStep(startBox: AABB, dx: number, dz: number): AABB | null {
    const upSwept = startBox.offset(0, this.stepHeight, 0).expand(dx, 0, dz);
    const upBoxes = this.world.collisionBoxes(upSwept);
    if (!upBoxes) {
      this.reliable = false;
      return null;
    }

    let raised = startBox;
    let y = this.stepHeight;
    for (const b of upBoxes) y = AABB.clipY(b, raised, y);
    if (y < 0.0001) return null;
    raised = raised.offset(0, y, 0);

    let x = dx;
    for (const b of upBoxes) x = AABB.clipX(b, raised, x);
    raised = raised.offset(x, 0, 0);
    let z = dz;
    for (const b of upBoxes) z = AABB.clipZ(b, raised, z);
    raised = raised.offset(0, 0, z);

    if (x === 0 && z === 0) return null;

    const downSwept = raised.expand(0, -this.stepHeight, 0);
    const downBoxes = this.world.collisionBoxes(downSwept);
    if (!downBoxes) {
      this.reliable = false;
      return null;
    }
    let drop = -this.stepHeight;
    for (const b of downBoxes) drop = AABB.clipY(b, raised, drop);
    return raised.offset(0, drop, 0);
  }

  private applyBox(box: AABB): void {
    const half = this.width / 2;
    this.pos = new Vec3(box.minX + half, box.minY, box.minZ + half);
    const centerX = (box.minX + box.maxX) / 2;
    const centerZ = (box.minZ + box.maxZ) / 2;
    this.pos = new Vec3(centerX, box.minY, centerZ);
  }

  private applyMotion(nx: number, ny: number, nz: number, hitGround: boolean): void {
    if (nx !== this.motion.x || nz !== this.motion.z) {
      // 水平撞墙
    }
    this.onGround = hitGround;
    if (hitGround) {
      this.motion.y = 0;
      if (this.fallDistance > 0) this.fallDistance = 0;
    } else if (ny < 0) {
      this.fallDistance -= ny;
    }
  }
}

/** 原项目 Simulation.java 里预生成的输入集合（3×3×2×2，潜行时 ×0.3） */
export function buildMovementInputs(): MovementInputState[] {
  const out: MovementInputState[] = [];
  for (let forward = -1; forward <= 1; forward++) {
    for (let strafe = -1; strafe <= 1; strafe++) {
      for (const jump of [true, false]) {
        for (const sneak of [true, false]) {
          out.push({
            moveForward: sneak ? forward * 0.3 : forward,
            moveStrafe: sneak ? strafe * 0.3 : strafe,
            jump,
            sneak,
          });
        }
      }
    }
  }
  return out;
}

export { BlockUtils };
