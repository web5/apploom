/** 后端 ErrorClass（packages/llm/src/errors.ts）的展示文案与处置建议 */
export type ErrorClass =
  | 'transient'
  | 'invalid_input'
  | 'invalid_output'
  | 'permission'
  | 'not_found'
  | 'budget'
  | 'verification'
  | 'execution'
  | 'unknown';

const META: Record<ErrorClass, { label: string; hint: string }> = {
  transient: { label: '临时故障', hint: '模型服务暂时不可用（已自动重试仍失败），稍后点「重试」即可' },
  invalid_input: { label: '请求非法', hint: '请求参数被服务端拒绝，重试无效，请检查输入或提示词' },
  invalid_output: { label: '输出不合规', hint: '模型输出未通过格式校验（已自动让模型修正仍失败），可点「修改」补充要求后重新生成' },
  permission: { label: '鉴权失败', hint: '检查 API Key 是否有效，修复后点「重试」' },
  not_found: { label: '资源不存在', hint: '模型名或接口地址可能配置错误' },
  budget: { label: '预算/额度用尽', hint: '本流水线 token 预算（PIPELINE_TOKEN_BUDGET）或模型服务商的额度已用完：调高预算，或检查服务商账户余额 / 开通后付费后再重试' },
  verification: { label: '代码校验未通过', hint: '生成的代码未通过 install / tsc / build 校验，可点「修改」描述问题后重新生成' },
  execution: { label: '执行失败', hint: '本地执行（如部署）失败，查看日志后点「重试」' },
  unknown: { label: '未知错误', hint: '查看日志定位原因' },
};

export function errorClassMeta(c?: string): { label: string; hint: string } | null {
  return c && c in META ? META[c as ErrorClass] : null;
}
