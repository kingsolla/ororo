/**
 * @file Main entry point for the Oroswoap Farming Bot.
 * Professional CLI interface with user-defined swap amount and cycle count.
 */

import readline from 'readline';
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { SigningCosmWasmClient } from "@cosmjs/cosmwasm-stargate";
import { GasPrice } from "@cosmjs/stargate";
import chalk from 'chalk';
import ora from 'ora';
import 'dotenv/config';

// --- Configuration ---
const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
const MNEMONIC = process.env.MNEMONIC;
const ROUTER_CONTRACT_ADDRESS = "zig15jqg0hmp9n06q0as7uk3x9xkwr9k3r7yh4ww2uc0hek8zlryrgmsamk4qg";
const EXPLORER_URL = "https://www.zigscan.org/tx/";
const ZIG_DENOM = "uzig";
const ORO_DENOM = "coin.zig10rfjm85jmzfhravjwpq3hcdz8ngxg7lxd0drkr.uoro";
const ZIG_AMOUNT_FOR_LP = "150000"; // 0.15 ZIG
const DELAY_BETWEEN_STEPS = 5; // seconds
const DELAY_BETWEEN_CYCLES = 5; // seconds
const DELAY_AFTER_ERROR = 10; // seconds
const RETRY_DELAY_HOURS = 1; // Fixed retry delay for insufficient funds


// --- Utility Functions ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const askQuestion = (query) => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans);
  }));
};

const runCountdown = async (hours) => {
  let seconds = hours * 3600;
  const spinner = ora(chalk.yellow(`Retrying in ${hours} hour(s)...`)).start();
  while (seconds > 0) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    spinner.text = chalk.yellow(`Retrying in ${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`);
    await sleep(1000);
    seconds--;
  }
  spinner.succeed(chalk.green('Countdown finished. Resuming operations...'));
};

const getFormattedBalance = async (client, address, denom, symbol) => {
  try {
    const balance = await client.getBalance(address, denom);
    return `${(parseInt(balance.amount) / 1000000).toFixed(4)} ${symbol}`;
  } catch (e) {
    return `0.0000 ${symbol}`;
  }
};

// --- Client Initialization ---
const initializeClient = async (mnemonic, rpcEndpoint) => {
  const spinner = ora(chalk.cyan('Initializing client...')).start();
  if (!mnemonic || !rpcEndpoint) {
    spinner.fail(chalk.red('Mnemonic and RPC Endpoint must be provided.'));
    throw new Error("Mnemonic and RPC Endpoint must be provided.");
  }
  try {
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "zig" });
    const [account] = await wallet.getAccounts();
    const gasPrice = GasPrice.fromString("0.025uzig");
    const client = await SigningCosmWasmClient.connectWithSigner(rpcEndpoint, wallet, { gasPrice });
    spinner.succeed(chalk.green('Client initialized successfully.'));
    return { account, client };
  } catch (error) {
    spinner.fail(chalk.red('Failed to initialize client.'));
    throw error;
  }
};

// --- Oroswoap Functions ---
const performSwap = async (client, senderAddress, amountToSwap) => {
  const spinner = ora(chalk.cyan(`[1/2] Executing swap for ${(parseInt(amountToSwap) / 1000000).toFixed(4)} ZIG...`)).start();
  try {
    const fundsToSend = [{ denom: ZIG_DENOM, amount: amountToSwap }];
    const swapMsg = {
      swap: {
        offer_asset: { info: { native_token: { denom: ZIG_DENOM } }, amount: amountToSwap },
        max_spread: "0.1",
      },
    };
    const result = await client.execute(senderAddress, ROUTER_CONTRACT_ADDRESS, swapMsg, "auto", "Auto Farming by Pro Bot", fundsToSend);
    spinner.succeed(chalk.green('Swap successful!'));
    console.log(chalk.green(`> Explorer: ${EXPLORER_URL}${result.transactionHash}`));
  } catch (error) {
    spinner.fail(chalk.red('Swap failed.'));
    throw error;
  }
};

const performAddLiquidity = async (client, senderAddress) => {
  const spinner = ora(chalk.cyan('[2/2] Adding liquidity...')).start();
  try {
    spinner.text = chalk.cyan(`Simulating pool ratio for ${(parseInt(ZIG_AMOUNT_FOR_LP) / 1000000)} ZIG...`);
    const simulationQuery = { simulation: { offer_asset: { amount: ZIG_AMOUNT_FOR_LP, info: { native_token: { denom: ZIG_DENOM } } } } };
    const simulationResult = await client.queryContractSmart(ROUTER_CONTRACT_ADDRESS, simulationQuery);
    let requiredOroAmount = simulationResult.return_amount;
    spinner.text = chalk.cyan(`Required: ${(parseInt(requiredOroAmount) / 1000000).toFixed(4)} ORO`);

    // Check available ORO balance
    const oroBalance = await client.getBalance(senderAddress, ORO_DENOM);
    const availableOro = parseInt(oroBalance.amount);
    if (availableOro < parseInt(requiredOroAmount)) {
      spinner.text = chalk.yellow(`Insufficient ORO: ${(availableOro / 1000000).toFixed(4)} available. Using available amount.`);
      requiredOroAmount = availableOro.toString();
    }

    const assets = [
      { info: { native_token: { denom: ORO_DENOM } }, amount: requiredOroAmount },
      { info: { native_token: { denom: ZIG_DENOM } }, amount: ZIG_AMOUNT_FOR_LP }
    ];
    const fundsForLiq = [
      { denom: ORO_DENOM, amount: requiredOroAmount },
      { denom: ZIG_DENOM, amount: ZIG_AMOUNT_FOR_LP }
    ];
    const liquidityMsg = { provide_liquidity: { assets: assets, slippage_tolerance: "0.1" } };
    const result = await client.execute(senderAddress, ROUTER_CONTRACT_ADDRESS, liquidityMsg, "auto", "Auto Farming by Pro Bot", fundsForLiq);
    spinner.succeed(chalk.green('Liquidity added successfully!'));
    console.log(chalk.green(`> Explorer: ${EXPLORER_URL}${result.transactionHash}`));
  } catch (error) {
    spinner.fail(chalk.red('Adding liquidity failed.'));
    throw error;
  }
};

// --- Farming Cycle ---
const runCycle = async (context, cycleCount, amountToSwap) => {
  console.log(chalk.blue('\n-----------------------------------------------------'));
  console.log(chalk.blue(`Starting Farming Cycle #${cycleCount} | ${new Date().toLocaleString()}`));
  console.log(chalk.blue('-----------------------------------------------------'));

  const spinner = ora(chalk.cyan('Checking wallet balance...')).start();
  const zigBalance = await getFormattedBalance(context.client, context.account.address, ZIG_DENOM, "ZIG");
  const oroBalance = await getFormattedBalance(context.client, context.account.address, ORO_DENOM, "ORO");
  spinner.succeed(chalk.green(`Balance: ${zigBalance}, ${oroBalance}`));

  await performSwap(context.client, context.account.address, amountToSwap);
  const waitSpinner = ora(chalk.cyan(`Waiting for ${DELAY_BETWEEN_STEPS} seconds...`)).start();
  await sleep(DELAY_BETWEEN_STEPS * 1000);
  waitSpinner.succeed(chalk.green('Wait complete.'));
  await performAddLiquidity(context.client, context.account.address);
  console.log(chalk.green(`\nCycle #${cycleCount} completed successfully!`));
};


  if (!MNEMONIC) {
    console.error(chalk.red('FATAL: MNEMONIC phrase not found in .env file. Bot is stopping.'));
    return;
  }

  // --- Get user input for swap amount ---
  let amountToSwap;
  while (true) {
    const userInput = await askQuestion(chalk.cyan('Enter the amount to swap in ZIG (e.g., 0.25): '));
    const parsedAmount = parseFloat(userInput);
    if (!isNaN(parsedAmount) && parsedAmount > 0) {
      amountToSwap = (parsedAmount * 1000000).toString(); // Convert to smallest unit
      console.log(chalk.green(`> Swap amount set to ${parsedAmount} ZIG.`));
      break;
    } else {
      console.log(chalk.red('> Invalid input. Please enter a positive number (e.g., 0.25).'));
    }
  }

  // --- Get user input for number of cycles ---
  let totalCycles;
  while (true) {
    const userInput = await askQuestion(chalk.cyan('Enter the number of swap cycles to perform (e.g., 10): '));
    const parsedCycles = parseInt(userInput);
    if (!isNaN(parsedCycles) && parsedCycles > 0) {
      totalCycles = parsedCycles;
      console.log(chalk.green(`> Number of cycles set to ${totalCycles}.`));
      break;
    } else {
      console.log(chalk.red('> Invalid input. Please enter a positive integer (e.g., 10).'));
    }
  }

  console.log(chalk.yellow(`> Retry delay set to ${RETRY_DELAY_HOURS} hours for insufficient funds.`));

  try {
    const { account, client } = await initializeClient(MNEMONIC, RPC_ENDPOINT);
    console.log(chalk.green(`> Connected to wallet: ${account.address}`));
    const context = { client, account };

    for (let cycleCount = 1; cycleCount <= totalCycles; cycleCount++) {
      try {
        await runCycle(context, cycleCount, amountToSwap);
        if (cycleCount < totalCycles) {
          const cycleSpinner = ora(chalk.cyan(`Waiting for ${DELAY_BETWEEN_CYCLES} seconds before the next cycle...`)).start();
          await sleep(DELAY_BETWEEN_CYCLES * 1000);
          cycleSpinner.succeed(chalk.green('Wait complete. Starting next cycle.'));
        }
      } catch (error) {
        const errorMsg = error.toString();
        console.error(chalk.red(`\nERROR occurred during cycle #${cycleCount}:`));
        console.error(chalk.red(`> Message: ${errorMsg}`));
        if (errorMsg.includes("insufficient funds")) {
          console.log(chalk.yellow('> Insufficient funds detected. Use the faucet if needed.'));
          await runCountdown(RETRY_DELAY_HOURS);
          cycleCount--; // Retry the same cycle
        } else {
          console.log(chalk.yellow(`> Unexpected error. Retrying in ${DELAY_AFTER_ERROR} seconds...`));
          await sleep(DELAY_AFTER_ERROR * 1000);
          cycleCount--; // Retry the same cycle
        }
      }
    }
    console.log(chalk.green(`\nAll ${totalCycles} cycles completed successfully!`));
  } catch (initError) {
    console.error(chalk.red('FATAL: Failed to initialize the client. Check RPC endpoint and mnemonic.'));
    console.error(chalk.red(`> Details: ${initError.message}`));
  }
};

main();
