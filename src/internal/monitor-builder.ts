import {
  AddSinksStep,
  AddTransformationsStep,
  BuildStep,
  ChooseDataSourceStep,
  DefineDataSourceStep,
  DispatchStrategy,
  KeysMatching,
  MonitorBuilderProps,
  NotifyStep,
  Transformation,
} from '../monitor-builder';
import {
  Data,
  DialectNotification,
  ResourceId,
  SubscriberEvent,
} from '../data-model';
import {
  DataSourceTransformationPipeline,
  NotificationSink,
  PollableDataSource,
  PushyDataSource,
} from '../ports';
import { Duration } from 'luxon';
import { exhaustMap, from, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Monitor, Monitors } from '../monitor-api';
import { DialectNotificationSink } from './dialect-notification-sink';

/**
 * A set of factory methods to create monitors
 */
export class MonitorsBuilderState<T extends Object> {
  chooseDataSourceStep?: ChooseDataSourceStepImpl;
  defineDataSourceStep?: DefineDataSourceStepImpl<T>;
  addTransformationsStep?: AddTransformationsStepImpl<T>;

  constructor(readonly builderProps: MonitorBuilderProps) {}
}

type DataSourceType = 'user-defined' | 'subscriber-events';

export class ChooseDataSourceStepImpl implements ChooseDataSourceStep {
  dataSourceType?: DataSourceType;

  constructor(readonly builderProps: MonitorBuilderProps) {}

  subscriberEvents(): AddTransformationsStep<SubscriberEvent> {
    this.dataSourceType = 'subscriber-events';
    const monitorsBuilderState = new MonitorsBuilderState<SubscriberEvent>(
      this.builderProps,
    );
    monitorsBuilderState.chooseDataSourceStep = this;
    return new AddTransformationsStepImpl<SubscriberEvent>(
      monitorsBuilderState,
    );
  }

  defineDataSource<T extends object>(): DefineDataSourceStep<T> {
    this.dataSourceType = 'user-defined';
    const monitorsBuilderState = new MonitorsBuilderState<T>(this.builderProps);
    monitorsBuilderState.chooseDataSourceStep = this;
    return new DefineDataSourceStepImpl<T>(monitorsBuilderState);
  }
}

type DataSourceStrategy = 'push' | 'poll';

export class DefineDataSourceStepImpl<T extends object>
  implements DefineDataSourceStep<T>
{
  dataSourceStrategy?: DataSourceStrategy;
  pushyDataSource?: PushyDataSource<T>;
  pollableDataSource?: PollableDataSource<T>;
  pollInterval?: Duration;

  constructor(private readonly monitorBuilderState: MonitorsBuilderState<T>) {
    this.monitorBuilderState.defineDataSourceStep = this;
  }

  poll(
    dataSource: PollableDataSource<T>,
    pollInterval: Duration,
  ): AddTransformationsStep<T> {
    this.pollableDataSource = dataSource;
    this.pollInterval = pollInterval;
    this.dataSourceStrategy = 'poll';
    return new AddTransformationsStepImpl(this.monitorBuilderState);
  }

  push(dataSource: PushyDataSource<T>): AddTransformationsStep<T> {
    this.pushyDataSource = dataSource;
    this.dataSourceStrategy = 'push';
    return new AddTransformationsStepImpl(this.monitorBuilderState);
  }
}

class AddTransformationsStepImpl<T extends object>
  implements AddTransformationsStep<T>
{
  dataSourceTransformationPipelines: DataSourceTransformationPipeline<
    T,
    any
  >[] = [];

  dispatchStrategy?: DispatchStrategy;

  constructor(private readonly monitorBuilderState: MonitorsBuilderState<T>) {
    monitorBuilderState.addTransformationsStep = this;
  }

  dispatch(strategy: DispatchStrategy): BuildStep<T> {
    this.dispatchStrategy = strategy;
    return new BuildStepImpl(this.monitorBuilderState!);
  }

  transform<V, R>(transformation: Transformation<T, V, R>): NotifyStep<T, R> {
    const dataSourceTransformationPipelines: DataSourceTransformationPipeline<
      T,
      Data<R, T>
    >[] = [];

    const { keys, pipelines } = transformation;
    const adaptedToDataSourceTypePipelines: ((
      dataSource: PushyDataSource<T>,
    ) => Observable<Data<R, T>>)[] = keys.flatMap((key: KeysMatching<T, V>) =>
      pipelines.map(
        (
          pipeline: (source: Observable<Data<V, T>>) => Observable<Data<R, T>>,
        ) => {
          const adaptedToDataSourceType: (
            dataSource: PushyDataSource<T>,
          ) => Observable<Data<R, T>> = (dataSource: PushyDataSource<T>) =>
            pipeline(
              dataSource.pipe(
                map(({ data: origin, resourceId }) => ({
                  context: {
                    origin,
                    resourceId,
                    trace: [],
                  },
                  value: origin[key] as unknown as V,
                })),
              ),
            );
          return adaptedToDataSourceType;
        },
      ),
    );
    dataSourceTransformationPipelines.push(...adaptedToDataSourceTypePipelines);
    return new NotifyStepImpl(this, dataSourceTransformationPipelines);
  }
}

class NotifyStepImpl<T extends object, R> implements NotifyStep<T, R> {
  constructor(
    private readonly addTransformationsStep: AddTransformationsStepImpl<T>,
    private readonly dataSourceTransformationPipelines: DataSourceTransformationPipeline<
      T,
      Data<R, T>
    >[],
  ) {}

  notify(): AddSinksStep<T, R> {
    return new AddSinksStepImpl(
      this.addTransformationsStep,
      this.dataSourceTransformationPipelines,
    );
  }
}

class AddSinksStepImpl<T extends object, R> implements AddSinksStep<T, R> {
  private sinkWriters: ((
    data: Data<R, T>,
    resources: ResourceId[],
  ) => Promise<any>)[] = [];

  constructor(
    private readonly addTransformationsStep: AddTransformationsStepImpl<T>,
    private readonly dataSourceTransformationPipelines: DataSourceTransformationPipeline<
      T,
      Data<R, T>
    >[],
    private readonly dialectNotificationSink?: DialectNotificationSink,
  ) {}

  and(): AddTransformationsStep<T> {
    const transformAndLoadPipelines: DataSourceTransformationPipeline<
      T,
      any
    >[] = this.dataSourceTransformationPipelines.map(
      (
        dataSourceTransformationPipeline: DataSourceTransformationPipeline<
          T,
          Data<R, T>
        >,
      ) => {
        const transformAndLoadPipeline: DataSourceTransformationPipeline<
          T,
          any
        > = (dataSource, targets) =>
          dataSourceTransformationPipeline(dataSource, targets).pipe(
            exhaustMap((event) =>
              from(
                Promise.all(this.sinkWriters.map((it) => it(event, targets))),
              ),
            ),
          );
        return transformAndLoadPipeline;
      },
    );
    this.addTransformationsStep.dataSourceTransformationPipelines.push(
      ...transformAndLoadPipelines,
    );
    return this.addTransformationsStep!;
  }

  dialectThread(
    adapter: (data: Data<R, T>) => DialectNotification,
  ): AddSinksStep<T, R> {
    if (!this.dialectNotificationSink) {
      throw new Error('Dialect notification sink undefined');
    }
    const sinkWriter: (
      data: Data<R, T>,
      resources: ResourceId[],
    ) => Promise<void> = (data, resources) =>
      this.dialectNotificationSink!.push(adapter(data), resources);
    this.sinkWriters.push(sinkWriter);
    return this;
  }

  custom<M>(adapter: (data: Data<R, T>) => M, sink: NotificationSink<M>) {
    const sinkWriter: (
      data: Data<R, T>,
      resources: ResourceId[],
    ) => Promise<void> = (data, resources) =>
      sink.push(adapter(data), resources);
    this.sinkWriters.push(sinkWriter);
    return this;
  }
}

class BuildStepImpl<T extends object> implements BuildStep<T> {
  constructor(private readonly monitorBuilderState: MonitorsBuilderState<T>) {}

  build(): Monitor<T> {
    const {
      builderProps,
      chooseDataSourceStep,
      defineDataSourceStep,
      addTransformationsStep,
    } = this.monitorBuilderState;

    if (!builderProps || !chooseDataSourceStep || !addTransformationsStep) {
      throw new Error(
        'Expected [builderProps, chooseDataSourceStep, addTransformationsStep] to be defined',
      );
    }
    switch (chooseDataSourceStep.dataSourceType) {
      case 'user-defined': {
        if (!defineDataSourceStep) {
          throw new Error('Expected data source to be defined');
        }
        return this.createUserDefinedMonitor(
          defineDataSourceStep,
          addTransformationsStep,
          builderProps,
        );
      }
      case 'subscriber-events': {
        return this.buildSubscriberEventMonitor(
          addTransformationsStep,
          builderProps,
        );
      }
      default: {
        throw new Error(
          `Unexpected data source type: ${chooseDataSourceStep.dataSourceType}`,
        );
      }
    }
  }

  private buildSubscriberEventMonitor(
    addTransformationsStep: AddTransformationsStepImpl<T>,
    builderProps: MonitorBuilderProps,
  ) {
    const { dataSourceTransformationPipelines, dispatchStrategy } =
      addTransformationsStep;
    if (!dataSourceTransformationPipelines || !dispatchStrategy) {
      throw new Error(
        'Expected [dataSourceTransformationPipelines, dispatchStrategy] to be defined',
      );
    }
    return Monitors.factory(builderProps).createSubscriberEventMonitor(
      dataSourceTransformationPipelines as unknown as DataSourceTransformationPipeline<
        SubscriberEvent,
        any
      >[],
    );
  }

  private createUserDefinedMonitor(
    defineDataSourceStep: DefineDataSourceStepImpl<T>,
    addTransformationsStep: AddTransformationsStepImpl<T>,
    builderProps: MonitorBuilderProps,
  ) {
    const { dataSourceStrategy } = defineDataSourceStep;
    switch (dataSourceStrategy) {
      case 'poll':
        return this.createForPollable(
          defineDataSourceStep,
          addTransformationsStep,
          builderProps,
        );
      case 'push':
        return this.createForPushy(
          defineDataSourceStep,
          addTransformationsStep,
          builderProps,
        );
      default:
        throw new Error('Expected data source strategy to be defined');
    }
  }

  private createForPollable(
    defineDataSourceStep: DefineDataSourceStepImpl<T>,
    addTransformationsStep: AddTransformationsStepImpl<T>,
    builderProps: MonitorBuilderProps,
  ) {
    const { pollableDataSource, pollInterval } = defineDataSourceStep;
    const { dataSourceTransformationPipelines, dispatchStrategy } =
      addTransformationsStep;
    if (
      !pollableDataSource ||
      !pollInterval ||
      !dataSourceTransformationPipelines ||
      !dispatchStrategy
    ) {
      throw new Error(
        'Expected [pollableDataSource, pollInterval, dataSourceTransformationPipelines, dispatchStrategy] to be defined',
      );
    }

    switch (addTransformationsStep.dispatchStrategy) {
      case 'broadcast':
        return Monitors.factory(builderProps).createBroadcastMonitor<T>(
          pollableDataSource,
          dataSourceTransformationPipelines,
          pollInterval,
        );
      case 'unicast':
        return Monitors.factory(builderProps).createUnicastMonitor<T>(
          pollableDataSource,
          dataSourceTransformationPipelines,
          pollInterval,
        );
      default:
        throw new Error(
          'Unknown dispatchStrategy: ' +
            addTransformationsStep.dispatchStrategy,
        );
    }
  }

  private createForPushy(
    defineDataSourceStep: DefineDataSourceStepImpl<T>,
    addTransformationsStep: AddTransformationsStepImpl<T>,
    builderProps: MonitorBuilderProps,
  ) {
    const { pushyDataSource } = defineDataSourceStep;
    const { dataSourceTransformationPipelines, dispatchStrategy } =
      addTransformationsStep;
    if (
      !pushyDataSource ||
      !dataSourceTransformationPipelines ||
      !dispatchStrategy
    ) {
      throw new Error(
        'Expected [pushyDataSource, dataSourceTransformationPipelines, dispatchStrategy] to be defined',
      );
    }
    return Monitors.factory(builderProps).createUnicastMonitor<T>(
      pushyDataSource,
      dataSourceTransformationPipelines,
      Duration.fromObject({ seconds: 1 }), // TODO: make optional
    );
  }
}
