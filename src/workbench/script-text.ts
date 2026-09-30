import { mergeIdolyScript } from '../../server/idoly-script.mjs';
import type {CsvDataLine} from './upstream/csv';
/** Adapted from Campus Viewer: Idoly IDs identify exact script line/field occurrences. */
export function mergeScriptText(raw:string,rows:CsvDataLine[],names:Record<string,string>={}):string{return mergeIdolyScript(raw,rows,names)}
