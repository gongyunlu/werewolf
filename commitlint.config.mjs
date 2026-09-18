export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat', // 新增功能
        'fix', // 修复缺陷
        'perf', // 性能优化
        'refactor', // 重构，不改变外部行为
        'style', // 格式调整，不影响逻辑
        'test', // 测试相关
        'docs', // 文档与注释
        'build', // 构建工具与依赖变更
        'ci', // 持续集成配置
        'chore', // 其他不修改业务代码的变更
        'revert', // 回滚
      ],
    ],
    'subject-case': [0],
    'header-max-length': [2, 'always', 100],
  },
};
