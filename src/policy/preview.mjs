import {evaluatePolicy} from './evaluator.mjs';

export function previewPolicy(sample,policy,now=new Date()) {
  return evaluatePolicy(policy,sample,now);
}
