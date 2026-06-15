import type { RowCount, BallDirection, PhysicsConfig, BallSpeed } from '../types';
import { getPhysicsConfig, COLLISION_CATEGORIES, BALL_MASS, SPEED_CONFIG } from './physics-config';
import { getMultiplier, calculateFinalSlot } from './multipliers';
import { PixiRenderer } from './pixi-renderer';

// Dynamic import for Matter.js to reduce initial bundle size
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Matter: any;
let Engine: typeof import('matter-js').Engine;
let Runner: typeof import('matter-js').Runner;
let World: typeof import('matter-js').World;
let Bodies: typeof import('matter-js').Bodies;
let Composite: typeof import('matter-js').Composite;
let Events: typeof import('matter-js').Events;
let Body: typeof import('matter-js').Body;
let Vector: typeof import('matter-js').Vector;

export interface PlinkoEngineCallbacks {
  onPinHit?: (ballId: string, pinIndex: number) => void;
  onBallLanded?: (ballId: string, slotIndex: number, multiplier: number) => void;
  onAllBallsLanded?: () => void;
}

interface BallInfo {
  body: Matter.Body;
  path: BallDirection[];
  id: string;
}

interface SteerData {
  ball: Matter.Body;
  direction: BallDirection;
  pin: Matter.Body;
  targetX: number;
  targetY: number;
}

export class PlinkoEngine {
  // engine/world are created lazily in init() once Matter.js is dynamically
  // imported; the definite-assignment assertion documents that they are set
  // before any use rather than masking the type with `any`.
  private engine!: Matter.Engine;
  private runner: Matter.Runner | null = null;
  private world!: Matter.World;
  private renderer: PixiRenderer | null = null;
  private renderCallback: (() => void) | null = null;

  private rows: RowCount;
  private speed: BallSpeed = 'normal';
  private physicsConfig: PhysicsConfig;
  private worldWidth: number = 0;
  private worldHeight: number = 0;

  private balls: Map<string, BallInfo> = new Map();
  private ballsToSteer: Map<string, SteerData> = new Map();
  private activeBallCount: number = 0;

  private callbacks: PlinkoEngineCallbacks;
  private isRunning: boolean = false;

  constructor(rows: RowCount, callbacks: PlinkoEngineCallbacks = {}) {
    this.rows = rows;
    this.callbacks = callbacks;
    this.physicsConfig = getPhysicsConfig(rows, typeof window !== 'undefined' ? window.innerWidth : 800);

    // Engine and world are created in init() once Matter.js has loaded.
  }

  /**
   * Initialize the engine with a canvas element
   */
  async init(canvas: HTMLCanvasElement): Promise<void> {
    // Dynamically import Matter.js on first use
    if (!Matter) {
      const matterModule = await import('matter-js');
      Matter = matterModule.default;
      Engine = Matter.Engine;
      Runner = Matter.Runner;
      World = Matter.World;
      Bodies = Matter.Bodies;
      Composite = Matter.Composite;
      Events = Matter.Events;
      Body = Matter.Body;
      Vector = Matter.Vector;

      // Now create the engine and world
      this.engine = Engine.create({
        gravity: { x: 0, y: 1, scale: 0.001 },
        enableSleeping: false,
      });
      this.world = this.engine.world;
    }

    // Use canvas dimensions directly (set by the hook from container size)
    this.worldWidth = canvas.width;
    this.worldHeight = canvas.height;

    // Recalculate physics config based on actual width
    this.physicsConfig = getPhysicsConfig(this.rows, this.worldWidth);

    // Initialize Pixi.js renderer
    this.renderer = new PixiRenderer();
    await this.renderer.init(canvas, this.worldWidth, this.worldHeight);

    this.createWorld();
    this.setupEvents();

    // Render initial pins (static elements)
    const bodies = Composite.allBodies(this.world);
    this.renderer.renderPins(bodies, this.physicsConfig.pinSize);

    // Remove existing render callback before adding new one
    if (this.renderCallback && this.renderer) {
      this.renderer.removeTickerCallback(this.renderCallback);
    }

    // Setup render loop using Pixi ticker
    this.renderCallback = () => {
      if (this.renderer && this.isRunning) {
        this.renderer.renderBalls(this.balls);
      }
    };
    this.renderer.addTickerCallback(this.renderCallback);

    this.runner = Runner.create();
    Runner.run(this.runner, this.engine);

    this.isRunning = true;
  }

  /**
   * Create all world elements: pins, walls, floor, multiplier zones
   */
  private createWorld(): void {
    const { pinGap, pinSize } = this.physicsConfig;
    const elements: Matter.Body[] = [];

    // Create pins
    for (let lineIndex = 0; lineIndex < this.rows; lineIndex++) {
      const linePins = 3 + lineIndex;
      const lineWidth = linePins * pinGap;

      for (let pinIndex = 0; pinIndex < linePins; pinIndex++) {
        const pin = Bodies.circle(
          (this.worldWidth / 2) - (lineWidth / 2) + (pinIndex * pinGap) + (pinGap / 2),
          (pinGap * 3) + (lineIndex * pinGap),
          pinSize,
          {
            isStatic: true,
            label: `pin-${lineIndex}`,
            collisionFilter: {
              category: COLLISION_CATEGORIES.collide,
            },
            restitution: 0.5,
            friction: 0,
            render: {
              fillStyle: '#ffffff',
            },
          }
        );
        elements.push(pin);
      }
    }

    // Create multiplier zones
    for (let i = 0; i <= this.rows; i++) {
      const multiplierZone = Bodies.rectangle(
        (this.worldWidth / 2) - ((pinGap * (this.rows + 2)) / 2) + ((i + 1) * pinGap),
        (pinGap * 3) + (this.rows * pinGap),
        pinGap * 0.9,
        pinGap * 0.75,
        {
          isStatic: true,
          label: `multiplier-${i}`,
          collisionFilter: {
            category: COLLISION_CATEGORIES.collide,
          },
          isSensor: true,
        }
      );
      elements.push(multiplierZone);
    }

    // Calculate wall positions - walls should be angled to form a funnel
    const wallTopY = pinGap * 2.5;  // Start just below ball drop point
    const wallBottomY = (pinGap * 3) + (this.rows * pinGap);  // End at multipliers
    const wallHeight = wallBottomY - wallTopY;
    const wallCenterY = wallTopY + (wallHeight / 2);

    // Left wall - angled inward
    elements.push(Bodies.rectangle(
      (this.worldWidth / 2) - (pinGap * 1.5) - ((this.rows + 2) * pinGap / 2),
      wallCenterY,
      wallHeight,
      15,
      {
        isStatic: true,
        label: 'left-wall',
        angle: Math.PI / 2 - 0.15,  // Slight inward angle
        collisionFilter: {
          category: COLLISION_CATEGORIES.collide,
        },
        render: { visible: false },
      }
    ));

    // Right wall - angled inward
    elements.push(Bodies.rectangle(
      (this.worldWidth / 2) + (pinGap * 1.5) + ((this.rows + 2) * pinGap / 2),
      wallCenterY,
      wallHeight,
      15,
      {
        isStatic: true,
        label: 'right-wall',
        angle: -Math.PI / 2 + 0.15,  // Slight inward angle
        collisionFilter: {
          category: COLLISION_CATEGORIES.collide,
        },
        render: { visible: false },
      }
    ));

    // Floor
    elements.push(Bodies.rectangle(
      0,
      (pinGap * 4) + (this.rows * pinGap),
      this.worldWidth * 2,
      25,
      {
        isStatic: true,
        label: 'floor',
        collisionFilter: {
          category: COLLISION_CATEGORIES.collide,
        },
        render: { visible: false },
      }
    ));

    Composite.add(this.world, elements);
  }

  /**
   * Setup collision events with continuous steering system
   */
  private setupEvents(): void {
    // 1. Collision Start - Register ball for steering when hitting a pin
    Events.on(this.engine, 'collisionStart', (event) => {
      for (const pair of event.pairs) {
        const ball = pair.bodyA.label.startsWith('ball-') ? pair.bodyA :
                     pair.bodyB.label.startsWith('ball-') ? pair.bodyB : null;

        if (!ball) continue;

        const other = ball === pair.bodyA ? pair.bodyB : pair.bodyA;
        const ballInfo = this.balls.get(ball.label);

        if (!ballInfo) continue;

        // Pin collision - register for continuous steering
        if (other.label.startsWith('pin-')) {
          const pinNumber = parseInt(other.label.slice(4), 10);
          const direction = ballInfo.path[pinNumber] as BallDirection;
          const { pinGap } = this.physicsConfig;

          // Calculate target position (where the ball should go after this pin)
          const targetX = other.position.x + (direction === 0 ? -1 : 1) * (pinGap / 2);
          const targetY = other.position.y + pinGap;

          this.ballsToSteer.set(ball.label, {
            ball,
            direction,
            pin: other,
            targetX,
            targetY,
          });

          this.callbacks.onPinHit?.(ballInfo.id, pinNumber);
        }

        // Multiplier collision - ball has landed
        if (other.label.startsWith('multiplier-')) {
          const slotIndex = parseInt(other.label.slice(11), 10);
          const multiplier = getMultiplier(this.rows, slotIndex);

          // Remove ball from world and tracking
          Composite.remove(this.world, ball);
          this.balls.delete(ball.label);
          this.ballsToSteer.delete(ball.label);
          this.activeBallCount--;

          this.callbacks.onBallLanded?.(ballInfo.id, slotIndex, multiplier);

          if (this.activeBallCount === 0) {
            this.callbacks.onAllBallsLanded?.();
          }
        }
      }
    });

    // 2. Before Update - Continuous steering (CRITICAL for path accuracy)
    // This runs every physics frame and guides balls toward their targets
    Events.on(this.engine, 'beforeUpdate', () => {
      const { pinGap, forceNeeded } = this.physicsConfig;

      this.ballsToSteer.forEach((steerData, ballLabel) => {
        const { ball, targetX, targetY } = steerData;

        // Calculate vector to target
        const toTarget = Vector.sub(
          { x: targetX, y: targetY },
          ball.position
        );
        const distance = Vector.magnitude(toTarget);

        // If ball reached near target, stop steering for this pin
        if (distance < pinGap * 0.4) {
          this.ballsToSteer.delete(ballLabel);
          return;
        }

        // Normalize direction vector
        const directionVector = Vector.normalise(toTarget);

        // Control maximum velocity to prevent erratic movement
        const currentSpeed = Vector.magnitude(ball.velocity);
        const maxSpeed = SPEED_CONFIG[this.speed].max;
        if (currentSpeed > maxSpeed) {
          Body.setVelocity(ball, Vector.mult(Vector.normalise(ball.velocity), maxSpeed));
        }

        // Apply steering force toward target
        const steerForce = Vector.mult(directionVector, forceNeeded * 1.5);
        Body.applyForce(ball, ball.position, steerForce);
      });
    });

    // 3. Collision End - Clean up steering when ball leaves pin area
    Events.on(this.engine, 'collisionEnd', (event) => {
      for (const pair of event.pairs) {
        const ball = pair.bodyA.label.startsWith('ball-') ? pair.bodyA :
                     pair.bodyB.label.startsWith('ball-') ? pair.bodyB : null;

        if (!ball) continue;

        const other = ball === pair.bodyA ? pair.bodyB : pair.bodyA;

        // Clean up steering when leaving a pin
        if (other.label.startsWith('pin-')) {
          // Don't immediately delete - let beforeUpdate handle removal based on distance
          // This ensures the ball continues toward target even after leaving pin collision
        }
      }
    });
  }

  /**
   * Generate a random path for the ball
   */
  generatePath(): BallDirection[] {
    return Array.from({ length: this.rows }, () =>
      (Math.random() > 0.5 ? 1 : 0) as BallDirection
    );
  }

  /**
   * Drop a ball with a predetermined path
   */
  dropBall(ballId: string, path?: BallDirection[]): { path: BallDirection[]; finalSlot: number } {
    const ballPath = path || this.generatePath();
    const finalSlot = calculateFinalSlot(ballPath);

    const { ballSize, pinGap } = this.physicsConfig;
    const ballLabel = `ball-${ballId}`;

    const ball = Bodies.circle(
      this.worldWidth / 2,
      pinGap * 2,
      ballSize,
      {
        label: ballLabel,
        collisionFilter: {
          group: -1,
          category: COLLISION_CATEGORIES.noCollide,
          mask: COLLISION_CATEGORIES.collide,
        },
        render: {
          fillStyle: '#fbbf24',
        },
        restitution: 0.5,
        friction: 0.001,
        frictionAir: 0.01,
      }
    );

    // Set mass after creation to ensure it applies correctly
    Body.setMass(ball, BALL_MASS);

    // Give initial downward velocity - NO random horizontal to ensure path accuracy
    Body.setVelocity(ball, { x: 0, y: SPEED_CONFIG[this.speed].initial });

    Composite.add(this.world, ball);

    this.balls.set(ballLabel, {
      body: ball,
      path: ballPath,
      id: ballId,
    });

    this.activeBallCount++;

    return { path: ballPath, finalSlot };
  }


  /**
   * Update rows configuration
   */
  setRows(rows: RowCount): void {
    this.rows = rows;
    this.physicsConfig = getPhysicsConfig(rows, this.worldWidth);

    // Clear and recreate world
    World.clear(this.world, false);
    this.balls.clear();
    this.ballsToSteer.clear();
    this.activeBallCount = 0;

    this.createWorld();

    // Re-render pins with new configuration
    if (this.renderer) {
      const bodies = Composite.allBodies(this.world);
      this.renderer.renderPins(bodies, this.physicsConfig.pinSize);
    }
  }

  /**
   * Update ball speed setting
   */
  setSpeed(speed: BallSpeed): void {
    this.speed = speed;
  }

  /**
   * Get current speed setting
   */
  getSpeed(): BallSpeed {
    return this.speed;
  }

  /**
   * Get current row count
   */
  getRows(): RowCount {
    return this.rows;
  }

  /**
   * Get physics config
   */
  getPhysicsConfig(): PhysicsConfig {
    return this.physicsConfig;
  }

  /**
   * Check if any balls are still active
   */
  hasActiveBalls(): boolean {
    return this.activeBallCount > 0;
  }

  /**
   * Resize the canvas and reconfigure physics
   */
  resize(width: number, height: number): void {
    if (!this.renderer) return;

    // Update world dimensions for physics
    this.worldWidth = width;
    this.worldHeight = height;

    this.physicsConfig = getPhysicsConfig(this.rows, width);

    // Pixi.js resize (non-destructive, handles DPR automatically)
    this.renderer.resize(width, height);

    // Recreate world with new dimensions
    World.clear(this.world, false);
    this.balls.clear();
    this.ballsToSteer.clear();
    this.activeBallCount = 0;

    this.createWorld();

    // Re-render pins with new dimensions
    const bodies = Composite.allBodies(this.world);
    this.renderer.renderPins(bodies, this.physicsConfig.pinSize);
  }

  /**
   * Cleanup and destroy the engine
   */
  destroy(): void {
    this.isRunning = false;

    if (this.renderer && this.renderCallback) {
      this.renderer.removeTickerCallback(this.renderCallback);
    }

    if (this.runner) {
      Runner.stop(this.runner);
    }

    World.clear(this.world, false);
    Engine.clear(this.engine);

    if (this.renderer) {
      this.renderer.destroy();
      this.renderer = null;
    }

    this.balls.clear();
    this.ballsToSteer.clear();
    this.renderCallback = null;
  }
}
