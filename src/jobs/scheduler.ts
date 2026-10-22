import type { AppLogger } from '../logging/logger.js';

export interface ScheduledJob {
  name: string;
  intervalMs: number;
  run: () => Promise<void> | void;
}

export interface JobScheduler {
  register(job: ScheduledJob): void;
  start(): void;
  stop(): void;
}

export class IntervalJobScheduler implements JobScheduler {
  private readonly jobs = new Map<string, ScheduledJob>();

  private readonly timers = new Map<string, NodeJS.Timeout>();

  private started = false;

  public constructor(private readonly logger: AppLogger) {}

  public register(job: ScheduledJob): void {
    if (!Number.isInteger(job.intervalMs) || job.intervalMs <= 0) {
      throw new Error(`Job interval must be a positive integer: ${job.name}`);
    }

    if (this.jobs.has(job.name)) {
      throw new Error(`A job named "${job.name}" is already registered`);
    }

    this.jobs.set(job.name, job);

    if (this.started) {
      this.startJob(job);
    }
  }

  public start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    for (const job of this.jobs.values()) {
      this.startJob(job);
    }
    this.logger.info({ jobCount: this.jobs.size }, 'Background job scheduler started');
  }

  public stop(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }

    this.timers.clear();
    this.started = false;
    this.logger.info('Background job scheduler stopped');
  }

  private startJob(job: ScheduledJob): void {
    const timer = setInterval(() => {
      void this.runJob(job);
    }, job.intervalMs);

    timer.unref();
    this.timers.set(job.name, timer);
  }

  private async runJob(job: ScheduledJob): Promise<void> {
    try {
      await job.run();
    } catch (error: unknown) {
      this.logger.error({ err: error, job: job.name }, 'Scheduled job failed');
    }
  }
}
