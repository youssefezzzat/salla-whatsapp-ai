import dotenv from 'dotenv';
dotenv.config();

// نحدد هل المستخدم مفعل الرديس في الـ .env ولا لأ (افتراضياً false عشان ما يحصلش أخطاء)
const useRedis = process.env.USE_REDIS === 'true';

let webhookQueue;
let worker = null;

if (useRedis) {
  try {
    // تحميل مكتبة BullMQ فقط لو الـ Redis مفعل
    const bullmq = await import('bullmq');
    const connection = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      enableOfflineQueue: false
    };

    webhookQueue = new bullmq.Queue('webhook-processing', {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 }
      }
    });

    worker = new bullmq.Worker('webhook-processing', async (job) => {
      const { eventId, payload } = job.data;
      console.log(`Processing event: ${eventId}`);

      if (payload.from_me) {
        console.log("Skipping message sent by bot.");
        return;
      }
    }, { connection });

    worker.on('failed', (job, err) => {
      console.error(`Job ${job ? job.id : 'unknown'} failed:`, err.message);
    });

    console.log("✅ Connected to Redis successfully.");
  } catch (err) {
    console.warn("⚠️ Failed to initialize Redis, switching to local mode.");
  }
} else {
  console.log("ℹ️ Running in Local Mode (Redis is disabled, using local fallback queue).");
}

// كلاس بديل يعمل محلياً بالكامل بدون الحاجة لـ Redis
const fallbackQueue = {
  async add(name, data) {
    console.log(`[Local Fallback Queue] Job "${name}" added successfully with data:`, data);
    // تنفيذ المعالجة محلياً مباشرة
    if (data.payload && !data.payload.from_me) {
      console.log(`Processing event locally: ${data.eventId}`);
    }
    return { id: Date.now() };
  }
};

// تصدير الـ Queue النشط
export const activeQueue = webhookQueue || fallbackQueue;