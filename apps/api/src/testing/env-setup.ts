/**
 * 用例要的那几个环境变量。
 *
 * 装配里有几处一构造就读环境（存储、队列的连接），而用例不加载 .env：
 * 在这儿补一份过得了校验的。地址都指向本机，密钥留空——
 * 密钥空着，任何一跑都开不了局，用例不会真花出去模型调用的钱。
 */
process.env.DATABASE_URL ??= 'postgresql://werewolf:werewolf@127.0.0.1:5432/werewolf';
process.env.MODEL_BASE_URL ??= 'https://model.example.test/v1';
process.env.MODEL_DEFAULT_MODEL ??= '用例模型';
process.env.MODEL_CAPABILITIES ??= '[]';
process.env.MODEL_REQUEST_TIMEOUT_MS ??= '1000';
process.env.MODEL_MAX_ATTEMPTS ??= '1';
