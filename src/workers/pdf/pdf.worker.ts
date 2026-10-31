import { exposeRpc, type RpcEndpoint } from '../rpc';
import { pdfHandlers } from './handlers';

exposeRpc(pdfHandlers, self as unknown as RpcEndpoint);
