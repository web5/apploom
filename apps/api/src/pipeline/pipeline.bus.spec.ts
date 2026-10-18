import { PipelineBus } from './pipeline.bus';
import { describeBusContract } from './pipeline.bus.contract';

describeBusContract('进程内（EventEmitter）', () => new PipelineBus());
