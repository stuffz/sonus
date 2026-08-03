import { logger } from "./logger";

interface CronJob {
  name: string;
  interval: number;
  handler: () => Promise<void> | void;
  timer: ReturnType<typeof setTimeout> | null;
  nextRun: number;
  lastRun: number | null;
}

class Cron {
  private jobs: Map<string, CronJob> = new Map();

  /**
   * Register a new cron job with drift correction
   * @param name Unique job identifier
   * @param interval Interval in milliseconds
   * @param handler Function to execute
   * @param runImmediately Run the handler once immediately before scheduling
   */
  register(name: string, interval: number, handler: () => Promise<void> | void, runImmediately = false): void {
    if (this.jobs.has(name)) {
      logger.warn(`Cron job "${name}" already exists, stopping previous instance`);
      this.stop(name);
    }

    const job: CronJob = {
      name,
      interval,
      handler,
      timer: null,
      nextRun: Date.now() + interval,
      lastRun: null,
    };

    this.jobs.set(name, job);
    this.schedule(job);

    logger.debug(`Cron job "${name}" registered (interval: ${interval}ms)`);

    if (runImmediately) {
      void this.execute(job);
    }
  }

  /**
   * Schedule the next run with drift correction
   */
  private schedule(job: CronJob): void {
    const delay = Math.max(0, job.nextRun - Date.now());

    job.timer = setTimeout(async () => {
      await this.execute(job);

      // Anchor to expected time for drift correction
      job.nextRun += job.interval;
      this.schedule(job);
    }, delay);
  }

  /**
   * Execute a job's handler with error handling
   */
  private async execute(job: CronJob): Promise<void> {
    job.lastRun = Date.now();
    try {
      await job.handler();
    } catch (error) {
      logger.error(`Cron job "${job.name}" failed`, error);
    }
  }

  /**
   * Stop a specific cron job
   */
  stop(name: string): boolean {
    const job = this.jobs.get(name);
    if (!job) {
      return false;
    }

    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }

    this.jobs.delete(name);
    logger.debug(`Cron job "${name}" stopped`);
    return true;
  }

  /**
   * Stop all cron jobs
   */
  stopAll(): void {
    const jobCount = this.jobs.size;
    for (const [name] of this.jobs) {
      this.stop(name);
    }
    logger.info(`Stopped ${jobCount} cron job(s)`);
  }

  /**
   * Get status of all registered jobs
   */
  getStatus(): { name: string; interval: number; nextRun: number; lastRun: number | null }[] {
    return Array.from(this.jobs.values()).map((job) => ({
      name: job.name,
      interval: job.interval,
      nextRun: job.nextRun,
      lastRun: job.lastRun,
    }));
  }
}

// Singleton instance
export const cron = new Cron();
