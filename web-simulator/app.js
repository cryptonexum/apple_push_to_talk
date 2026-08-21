const fs = require("fs");
const csv = require("csv-parser");
const TelegramBot = require("node-telegram-bot-api");

// Use environment variable
const token = "7682126642:AAERK3r7gvMPIqFb7ibSAZpJ7X5FnnVkLyA";

if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is missing");
}

const bot = new TelegramBot(token);

const message = `
🎉 <b>NOTY TGE CLAIM IS NOW LIVE!</b> 🚀

The time has come! Your <b>NOTY TGE claim is now available.</b>

🔥 If you participated in the NOTY ecosystem, you can now claim your eligible NOTY tokens.

⏰ <b>Don't wait — claim your tokens now.</b>

⚠️ <b>Security Notice:</b>
The NaughtyCoin team will never ask for your seed phrase or private key.

Only use official links.
`;


const options = {
  reply_markup: {
    inline_keyboard: [
      [
        {
          text: "🚀 CLAIM TGE NOW",
          web_app: {
            url: "https://naughtycoin.fun"
          }
        }
      ],
      [
        {
          text: "🌐 Discussion",
          url: "https://t.me/naughtycoin_chat"
        },
        {
          text: "📢 Channel",
          url: "https://t.me/naughtycoin_channel"
        }
      ],
      [
        {
          text: "𝕏 Twitter",
          url: "https://x.com/notycoin"
        }
      ]
    ]
  }
};

const users = [];

// Load users from CSV
fs.createReadStream("./userdata/test.csv")
  .pipe(csv())
  .on("data", (row) => {
    if (row.chat_id) {
      users.push(String(row.chat_id).trim());
    }
  })
  .on("end", () => {
    console.log(`✅ Loaded ${users.length} users.`);
    sendMessages(users);
  });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendMessages(chatIds) {
  const BATCH_SIZE = 10;
  const DELAY_BETWEEN_MESSAGES_MS = 500;
  const DELAY_BETWEEN_BATCHES_MS = 3000;

  for (let i = 0; i < chatIds.length; i += BATCH_SIZE) {
    const batch = chatIds.slice(i, i + BATCH_SIZE);

    for (const chatId of batch) {
      try {
        await bot.sendMessage(chatId, message, {
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: options.reply_markup
        });

        console.log(`✅ Sent to ${chatId}`);

        await sleep(DELAY_BETWEEN_MESSAGES_MS);
      } catch (err) {
        console.error(`❌ Failed to send to ${chatId}: ${err.message}`);
      }
    }

    if (i + BATCH_SIZE < chatIds.length) {
      console.log(
        `⏳ Waiting ${DELAY_BETWEEN_BATCHES_MS}ms before next batch...`
      );

      await sleep(DELAY_BETWEEN_BATCHES_MS);
    }
  }

  console.log("🎉 All messages sent!");
}