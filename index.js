require('dotenv').config();
const {
  Client, GatewayIntentBits,
  ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const { ethers } = require('ethers');
const fs = require('fs');

/* ════════════════════════════════════════════════
   CONFIG
════════════════════════════════════════════════ */
const DISCORD_TOKEN  = process.env.TRADING_BOT_TOKEN;
const HOT_WALLET_KEY = process.env.TRADING_WALLET_PRIVATE_KEY;
const HOT_WALLET     = '0xFd97e5e27e7Cd6dE16a94972c68869f2C748B6ef';

// DEX contracts (Tempo chain)
const FEE_ROUTER = '0x94197F5E9946B346906c0cA6142C0c143120721E';
const AMM_ROUTER = '0x1eeba975efc19794bb3b6f66589894625816d493';
const PATHUSD    = '0x20c0000000000000000000000000000000000000';

// Known tokens to show in wallet balances
const KNOWN_TOKENS = [
  { symbol: 'pathUSD', name: 'pathUSD',  address: '0x20c0000000000000000000000000000000000000', decimals: 6  },
  { symbol: 'CITCAT',  name: 'Citcats',  address: '0x0E3D1e74A49ba5b3F5c1E746d2bcaaB2dee8C62B', decimals: 18 },
  // Add more tokens here:
  // { symbol: 'TOKEN', name: 'Token Name', address: '0x...', decimals: 18 },
];

// Fee & trade config
const FLAT_FEE     = ethers.parseUnits('0.1', 6);    // 0.1 pathUSD
const SLIPPAGE     = 5;                               // 5%
const TRADE_TIMEOUT = 10 * 60 * 1000;                // 10 minutes
const MIN_TRADE    = ethers.parseUnits('1', 6);       // 1 pathUSD min
const MAX_TRADE    = ethers.parseUnits('1000', 6);    // 1000 pathUSD max

// Tempo RPC
const RPC_URL = 'https://rpc.tempo.xyz';

/* ════════════════════════════════════════════════
   TRADING REGISTRY — separate from holder registry
   Stores: tradingRegistry[guildId][userId] = wallet
════════════════════════════════════════════════ */
const TRADING_REGISTRY_FILE = './trading_registry.json';

function loadTradingRegistry() {
  try {
    if (fs.existsSync(TRADING_REGISTRY_FILE))
      return JSON.parse(fs.readFileSync(TRADING_REGISTRY_FILE, 'utf8'));
  } catch (e) { console.warn('Trading registry load error:', e.message); }
  return {};
}

function saveTradingRegistry(reg) {
  try {
    fs.writeFileSync(TRADING_REGISTRY_FILE, JSON.stringify(reg, null, 2));
  } catch (e) { console.warn('Trading registry save error:', e.message); }
}

/* ════════════════════════════════════════════════
   ABIs
════════════════════════════════════════════════ */
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

// Fee Router ABI — approve pathUSD for Fee Router, then call swapExactIn
const FEE_ROUTER_ABI = [
  // getAmountsOut via AMM Router for quotes
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
  // Real function selector from on-chain tx: 0x6df9ddfc
  // swapExactTokensForTokens(uint256,uint256,address[],address,uint256)
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
];

/* ════════════════════════════════════════════════
   PROVIDER & WALLET
════════════════════════════════════════════════ */
const provider  = new ethers.JsonRpcProvider(RPC_URL);
const botWallet = new ethers.Wallet(HOT_WALLET_KEY, provider);
const feeRouter = new ethers.Contract(FEE_ROUTER, FEE_ROUTER_ABI, botWallet);
const ammRouter = new ethers.Contract(AMM_ROUTER, FEE_ROUTER_ABI, provider); // read-only for quotes
const pathUSD   = new ethers.Contract(PATHUSD, ERC20_ABI, botWallet);

/* ════════════════════════════════════════════════
   PENDING TRADES
════════════════════════════════════════════════ */
const pendingTrades = new Map();

/* ════════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════════ */
function shortAddr(addr) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

async function getTokenInfo(tokenCA) {
  try {
    const token = new ethers.Contract(tokenCA, ERC20_ABI, provider);
    const [symbol, name, decimals] = await Promise.all([
      token.symbol(),
      token.name(),
      token.decimals(),
    ]);
    return { symbol, name, decimals };
  } catch (e) {
    throw new Error(`Invalid token contract — make sure it's a valid TIP-20 token on Tempo.`);
  }
}

async function getQuote(tokenCA, amountInPathUSD) {
  try {
    // Use AMM Router for quotes (Fee Router takes 0.3% fee so subtract from amountIn)
    const amountAfterFee = amountInPathUSD * 997n / 1000n;
    const amounts = await ammRouter.getAmountsOut(amountAfterFee, [PATHUSD, tokenCA]);
    return amounts[1];
  } catch (e) {
    throw new Error(`No liquidity found for this token on Enshrined.`);
  }
}

function applySlippage(amount) {
  return amount * BigInt(100 - SLIPPAGE) / 100n;
}

/* ════════════════════════════════════════════════
   PAYMENT VERIFIER
════════════════════════════════════════════════ */
async function verifyPayment(userWallet, expectedAmount) {
  try {
    const latest    = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latest - 500);

    const pathUSDContract = new ethers.Contract(PATHUSD, ERC20_ABI, provider);
    const filter = pathUSDContract.filters.Transfer(userWallet, HOT_WALLET);
    const logs   = await pathUSDContract.queryFilter(filter, fromBlock, 'latest');

    return logs.some(log => BigInt(log.args.value) >= BigInt(expectedAmount));
  } catch (e) {
    console.warn('Payment verify error:', e.message);
    return false;
  }
}

/* ════════════════════════════════════════════════
   WALLET BALANCE CHECKER
   Reads balances of all known tokens for a wallet
════════════════════════════════════════════════ */
async function getWalletBalances(walletAddress) {
  const balances = [];
  for (const token of KNOWN_TOKENS) {
    try {
      const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
      const balance  = await contract.balanceOf(walletAddress);
      const formatted = parseFloat(ethers.formatUnits(balance, token.decimals));
      balances.push({
        ...token,
        balance: formatted,
        balanceStr: formatted > 0
          ? formatted.toLocaleString('en-US', { maximumFractionDigits: 4 })
          : '0',
      });
    } catch (e) {
      balances.push({ ...token, balance: 0, balanceStr: '0' });
    }
  }
  return balances;
}


/* ════════════════════════════════════════════════
   EXECUTE SWAP
   1. Approve Fee Router to spend pathUSD
   2. Call swapExactIn on Fee Router
   Fee Router handles 0.3% fee internally then
   calls AMM Router → tokens sent to userWallet
════════════════════════════════════════════════ */
async function executeSwap(tokenCA, amountIn, amountOutMin, userWallet) {
  const deadline = Math.floor(Date.now() / 1000) + 300;
  const feeData  = await provider.getFeeData();
  const gasPrice = feeData.gasPrice || ethers.parseUnits('22', 'gwei');

  const txOpts = { gasPrice, type: 0 };

  // Step 1 — Approve Fee Router to spend pathUSD
  console.log(`📝 Approving Fee Router for ${ethers.formatUnits(amountIn, 6)} pathUSD...`);
  const approveTx = await pathUSD.approve(FEE_ROUTER, amountIn, {
    ...txOpts,
    gasLimit: 500000,
  });
  await approveTx.wait();
  console.log(`✅ Approved`);

  // Step 2 — Call Fee Router using raw selector 0x6df9ddfc
  // This is the exact function used in on-chain txs on Enshrined Exchange
  console.log(`🔄 Swapping via Fee Router for ${userWallet}...`);

  const iface = new ethers.Interface([
    'function swap(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])'
  ]);

  // Encode params then replace selector with correct one 0x6df9ddfc
  const encoded = iface.encodeFunctionData('swap', [
    amountIn,
    amountOutMin,
    [PATHUSD, tokenCA],
    userWallet,
    deadline,
  ]);
  const calldata = '0x6df9ddfc' + encoded.slice(10); // replace selector

  const swapTx = await botWallet.sendTransaction({
    to: FEE_ROUTER,
    data: calldata,
    gasLimit: 1200000,
    gasPrice: txOpts.gasPrice,
    type: 0,
  });
  const receipt = await swapTx.wait();
  console.log(`✅ Swap complete: ${receipt.hash}`);
  return receipt.hash;
}

/* ════════════════════════════════════════════════
   DISCORD CLIENT
════════════════════════════════════════════════ */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('clientReady', () => {
  console.log(`✅ Trading bot online as ${client.user.tag}`);
  console.log(`💳 Hot wallet: ${HOT_WALLET}`);
});

/* ════════════════════════════════════════════════
   INTERACTION HANDLER
════════════════════════════════════════════════ */
client.on('interactionCreate', async (interaction) => {
  const userId  = interaction.user.id;
  const guildId = interaction.guild?.id;

  /* ── REGISTER WALLET button ── */
  if (interaction.isButton() && interaction.customId === 'btn_register_wallet') {

    const modal = new ModalBuilder()
      .setCustomId('modal_register_wallet')
      .setTitle('Register Your Wallet');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('wallet_address')
          .setLabel('Your wallet address (0x...)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('0xYourWalletAddress')
          .setRequired(true)
          .setMinLength(42)
          .setMaxLength(42)
      )
    );

    await interaction.showModal(modal);
    return;
  }

  /* ── REGISTER WALLET modal submit ── */
  if (interaction.isModalSubmit() && interaction.customId === 'modal_register_wallet') {
    const wallet = interaction.fields.getTextInputValue('wallet_address').trim().toLowerCase();

    if (!ethers.isAddress(wallet)) {
      return interaction.reply({
        content: 'Invalid wallet address. Must start with 0x and be 42 characters.',
        ephemeral: true,
      });
    }

    const reg = loadTradingRegistry();
    if (!reg[guildId]) reg[guildId] = {};
    reg[guildId][userId] = wallet;
    saveTradingRegistry(reg);

    return interaction.reply({
      content:
        `**Wallet Registered!**\n\n` +
        `\`${wallet}\`\n\n` +
        `You can now use the **Buy Token** button to trade.\n` +
        `Purchased tokens will be sent to this wallet automatically.`,
      ephemeral: true,
    });
  }

  /* ── BUY TOKEN button ── */
  if (interaction.isButton() && interaction.customId === 'btn_buy') {

    const pending = pendingTrades.get(userId);

    // ── Second click: has pending → check payment & execute swap ──
    if (pending && Date.now() < pending.expiresAt) {
      await interaction.deferReply({ ephemeral: true });

      try {
        const totalRequired = BigInt(pending.amountIn) + FLAT_FEE;
        const paid = await verifyPayment(pending.userWallet, totalRequired);

        if (!paid) {
          return interaction.editReply(
            `Payment not found yet.\n\n` +
            `Send exactly **${ethers.formatUnits(totalRequired, 6)} pathUSD** to:\n` +
            `\`${HOT_WALLET}\`\n\n` +
            `Wait for tx to confirm then click **Buy Token** again.\n` +
            `⏰ ${Math.ceil((pending.expiresAt - Date.now()) / 60000)} minute(s) left.`
          );
        }

        await interaction.editReply(`Payment confirmed! Executing swap on Enshrined...`);

        const txHash = await executeSwap(
          pending.tokenCA,
          pending.amountIn,
          pending.amountOutMin,
          pending.userWallet
        );

        pendingTrades.delete(userId);

        return interaction.editReply(
          `**Swap Complete!**\n\n` +
          `Token: **${pending.tokenSymbol}**\n` +
          `Sent to: \`${shortAddr(pending.userWallet)}\`\n\n` +
          `[View on Explorer](https://explore.tempo.xyz/tx/${txHash})`
        );

      } catch (err) {
        console.error('Swap error:', err);
        return interaction.editReply(`Swap failed: ${err.message}`);
      }
    }

    // ── Expired pending → clear ──
    if (pending && Date.now() >= pending.expiresAt) {
      pendingTrades.delete(userId);
    }

    // ── First click → check if wallet is registered ──
    const reg       = loadTradingRegistry();
    const userWallet = reg[guildId]?.[userId];

    if (!userWallet) {
      return interaction.reply({
        content:
          `You need to register your wallet first!\n\n` +
          `Click the **Register Wallet** button to add your wallet.\n` +
          `The trading bot will send purchased tokens to your registered wallet.`,
        ephemeral: true,
      });
    }

    // Show trade modal
    const modal = new ModalBuilder()
      .setCustomId('modal_trade')
      .setTitle('Buy Token');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('token_ca')
          .setLabel('Token Contract Address (0x...)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('0xTokenContractAddress')
          .setRequired(true)
          .setMinLength(42)
          .setMaxLength(42)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('amount_in')
          .setLabel('Amount to spend (pathUSD)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 10')
          .setRequired(true)
          .setMaxLength(10)
      )
    );

    await interaction.showModal(modal);
    return;
  }

  /* ── TRADE MODAL SUBMIT ── */
  if (interaction.isModalSubmit() && interaction.customId === 'modal_trade') {
    await interaction.deferReply({ ephemeral: true });

    const tokenCA   = interaction.fields.getTextInputValue('token_ca').trim();
    const amountStr = interaction.fields.getTextInputValue('amount_in').trim();

    // Validate amount
    let amountIn;
    try {
      amountIn = ethers.parseUnits(amountStr, 6);
      if (amountIn < MIN_TRADE) return interaction.editReply(`Minimum trade is 1 pathUSD.`);
      if (amountIn > MAX_TRADE) return interaction.editReply(`Maximum trade is 1000 pathUSD.`);
    } catch {
      return interaction.editReply(`Invalid amount. Please enter a number like: 10`);
    }

    // Validate token address
    if (!ethers.isAddress(tokenCA)) {
      return interaction.editReply(`Invalid token address.`);
    }

    try {
      const tokenInfo    = await getTokenInfo(tokenCA);
      const amountOut    = await getQuote(tokenCA, amountIn);
      const amountOutMin = applySlippage(amountOut);
      const totalCost    = amountIn + FLAT_FEE;

      const reg        = loadTradingRegistry();
      const userWallet = reg[guildId]?.[userId];

      pendingTrades.set(userId, {
        tokenCA,
        tokenSymbol:  tokenInfo.symbol,
        tokenName:    tokenInfo.name,
        amountIn,
        amountOutMin,
        userWallet,
        expiresAt: Date.now() + TRADE_TIMEOUT,
        guildId,
      });

      return interaction.editReply(
        `**Trade Quote**\n\n` +
        `Token: **${tokenInfo.name} (${tokenInfo.symbol})**\n` +
        `Spending: **${amountStr} pathUSD**\n` +
        `You receive: **~${ethers.formatUnits(amountOut, tokenInfo.decimals)} ${tokenInfo.symbol}**\n` +
        `Bot fee: **0.1 pathUSD**\n` +
        `Total to send: **${ethers.formatUnits(totalCost, 6)} pathUSD**\n` +
        `Slippage: 5%\n\n` +
        `**Send ${ethers.formatUnits(totalCost, 6)} pathUSD to:**\n` +
        `\`${HOT_WALLET}\`\n\n` +
        `Then click **Buy Token** again to confirm.\n` +
        `⏰ You have **10 minutes**.`
      );

    } catch (err) {
      return interaction.editReply(`Error: ${err.message}`);
    }
  }

  /* ── ACTIVE TRADE button ── */
  if (interaction.isButton() && interaction.customId === 'btn_trade_status') {
    const pending = pendingTrades.get(userId);

    if (!pending || Date.now() >= pending.expiresAt) {
      return interaction.reply({
        content: 'No active trade. Click **Buy Token** to start.',
        ephemeral: true,
      });
    }

    const mins      = Math.ceil((pending.expiresAt - Date.now()) / 60000);
    const totalCost = BigInt(pending.amountIn) + FLAT_FEE;

    return interaction.reply({
      content:
        `**Active Trade**\n\n` +
        `Token: **${pending.tokenName} (${pending.tokenSymbol})**\n` +
        `Send: **${ethers.formatUnits(totalCost, 6)} pathUSD** to:\n` +
        `\`${HOT_WALLET}\`\n\n` +
        `Tokens go to: \`${shortAddr(pending.userWallet)}\`\n` +
        `⏰ Expires in **${mins} minute(s)**`,
      ephemeral: true,
    });
  }

  /* ── CANCEL TRADE button ── */
  if (interaction.isButton() && interaction.customId === 'btn_trade_cancel') {
    pendingTrades.delete(userId);
    return interaction.reply({
      content: 'Trade cancelled.',
      ephemeral: true,
    });
  }

  /* ── MY WALLET button ── */
  if (interaction.isButton() && interaction.customId === 'btn_my_wallet') {
    const reg        = loadTradingRegistry();
    const userWallet = reg[guildId]?.[userId];

    if (!userWallet) {
      return interaction.reply({
        content: 'No wallet registered. Click **Register Wallet** to add your wallet.',
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const balances = await getWalletBalances(userWallet);
      const balanceLines = balances
        .map(t => `**${t.symbol}:** ${t.balanceStr}`)
        .join('\n');

      return interaction.editReply(
        `**Your Wallet**\n\n` +
        `\`${userWallet}\`\n\n` +
        `**Balances:**\n${balanceLines}\n\n` +
        `Click **Register Wallet** to update your wallet address.`
      );
    } catch (e) {
      return interaction.editReply(
        `**Your Wallet**\n\n` +
        `\`${userWallet}\`\n\n` +
        `Could not fetch balances. Try again later.\n\n` +
        `Click **Register Wallet** to update your wallet address.`
      );
    }
  }
});

/* ════════════════════════════════════════════════
   MESSAGE HANDLER — !tradesetup (admin only)
════════════════════════════════════════════════ */
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild)     return;

  const cmd    = message.content.trim().split(' ')[0].toLowerCase();
  const userId = message.author.id;

  if (cmd !== '!tradesetup') return;

  const member = await message.guild.members.fetch(userId).catch(() => null);
  if (!member?.permissions.has('Administrator'))
    return message.reply('You need Administrator permission to run this.');

  await message.delete().catch(() => {});

  const embed = new EmbedBuilder()
    .setTitle('Citcats Trading Bot')
    .setColor(0xf5c800)
    .setDescription(
      `**Buy any TIP-20 token on Tempo chain directly from Discord.**\n\n` +
      `**How it works**\n` +
      `1. Click **Register Wallet** to link your wallet\n` +
      `2. Click **Buy Token** and enter token CA + amount\n` +
      `3. Bot shows you the quote\n` +
      `4. Send pathUSD to the bot wallet\n` +
      `5. Click **Buy Token** again — tokens sent to your wallet!\n\n` +
      `**Fee:** 0.1 pathUSD flat per trade\n` +
      `**Slippage:** 5%\n` +
      `**Min/Max:** 1 — 1000 pathUSD\n\n` +
      `*Powered by Enshrined on Tempo Chain*`
    )
    .setFooter({ text: 'Powered by Enshrined • Tempo Chain' });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_register_wallet')
      .setLabel('Register Wallet')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('btn_my_wallet')
      .setLabel('My Wallet')
      .setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_buy')
      .setLabel('Buy Token')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('btn_trade_status')
      .setLabel('Active Trade')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('btn_trade_cancel')
      .setLabel('Cancel Trade')
      .setStyle(ButtonStyle.Danger),
  );

  await message.channel.send({ embeds: [embed], components: [row1, row2] });
});

client.login(DISCORD_TOKEN);