import { InMemorySubscriberRepository } from './in-memory-subscriber.repository';
import { OnChainSubscriberRepository } from './on-chain-subscriber.repository';
import { Duration } from 'luxon';
import {
  catchError,
  exhaustMap,
  from,
  mergeMap,
  Observable,
  throwError,
  TimeoutError,
  timer,
} from 'rxjs';
import { MonitorFactory } from '../monitor-factory';
import {
  DataSource,
  DataSourceTransformationPipeline,
  PollableDataSource,
  PushyDataSource,
  SubscriberRepository,
} from '../ports';
import { Monitor, MonitorProps } from '../monitor-api';
import { ResourceId, SourceData, SubscriberEvent } from '../data-model';
import { timeout } from 'rxjs/operators';
import {
  NoopWeb2SubscriberRepository,
  Web2SubscriberRepository,
} from '../web-subscriber.repository';
import { findAllDistinct } from './subsbscriber-repository-utilts';
import { DefaultMonitor } from './default-monitor';

export class DefaultMonitorFactory implements MonitorFactory {
  private readonly subscriberRepository: SubscriberRepository;
  private readonly web2SubscriberRepository: Web2SubscriberRepository;

  private readonly shutdownHooks: (() => Promise<any>)[] = [];

  constructor({
    dialectProgram,
    monitorKeypair,
    subscriberRepository,
    web2SubscriberRepository,
  }: MonitorProps) {
    if (dialectProgram && monitorKeypair) {
      const onChainSubscriberRepository = new OnChainSubscriberRepository(
        dialectProgram,
        monitorKeypair,
      );
      this.shutdownHooks.push(() => onChainSubscriberRepository.tearDown());
      this.subscriberRepository = InMemorySubscriberRepository.decorate(
        onChainSubscriberRepository,
      );
    }
    this.web2SubscriberRepository =
      web2SubscriberRepository ?? new NoopWeb2SubscriberRepository();
    if (subscriberRepository) {
      this.subscriberRepository = subscriberRepository;
    }
    // @ts-ignore
    if (!this.subscriberRepository) {
      throw new Error(
        'Please specify either dialectProgram & monitorKeypair or subscriberRepository',
      );
    }
  }

  async shutdown() {
    return Promise.all(this.shutdownHooks.map((it) => it()));
  }

  createDefaultMonitor<T extends object>(
    dataSource: DataSource<T>,
    datasourceTransformationPipelines: DataSourceTransformationPipeline<
      T,
      any
    >[],
    pollInterval: Duration = Duration.fromObject({ seconds: 10 }),
  ): Monitor<T> {
    const pushyDataSource = !('subscribe' in dataSource)
      ? this.toPushyDataSource(
          dataSource as PollableDataSource<T>,
          pollInterval,
          this.subscriberRepository,
          this.web2SubscriberRepository,
        )
      : dataSource;
    const monitor = new DefaultMonitor<T>(
      pushyDataSource,
      datasourceTransformationPipelines,
      this.subscriberRepository,
      this.web2SubscriberRepository,
    );
    this.shutdownHooks.push(() => monitor.stop());
    return monitor;
  }

  createSubscriberEventMonitor(
    dataSourceTransformationPipelines: DataSourceTransformationPipeline<
      SubscriberEvent,
      any
    >[],
  ): Monitor<SubscriberEvent> {
    const dataSource: PushyDataSource<SubscriberEvent> = new Observable<
      SourceData<SubscriberEvent>
    >((subscriber) =>
      this.subscriberRepository.subscribe(
        (resourceId) =>
          subscriber.next({
            groupingKey: resourceId.toBase58(),
            data: {
              resourceId,
              state: 'added',
            },
          }),
        (resourceId) =>
          subscriber.next({
            groupingKey: resourceId.toBase58(),
            data: {
              resourceId,
              state: 'removed',
            },
          }),
      ),
    );
    const monitor = new DefaultMonitor<SubscriberEvent>(
      dataSource,
      dataSourceTransformationPipelines,
      this.subscriberRepository,
      this.web2SubscriberRepository,
    );
    this.shutdownHooks.push(() => monitor.stop());
    return monitor;
  }

  private toPushyDataSource<T extends object>(
    dataSource: PollableDataSource<T>,
    pollInterval: Duration,
    subscriberRepository: SubscriberRepository,
    web2SubscriberRepository: Web2SubscriberRepository,
    pollTimeout: Duration = Duration.fromObject({ minutes: 5 }),
  ): PushyDataSource<T> {
    return timer(0, pollInterval.toMillis()).pipe(
      exhaustMap(() =>
        from(findAllDistinct(subscriberRepository, web2SubscriberRepository)),
      ),
      exhaustMap((resources: ResourceId[]) => from(dataSource(resources))),
      timeout(pollTimeout.toMillis()),
      catchError((error) => {
        if (error instanceof TimeoutError) {
          return throwError(
            new Error(
              `Poll timeout of ${pollTimeout.toISO()} reached. ` + error,
            ),
          );
        }
        return throwError(error);
      }),
      mergeMap((it) => it),
    );
  }
}
