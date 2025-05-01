// bot.js

// Import required modules
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  VersionedTransaction,
  clusterApiUrl,
  SendTransactionError,
} from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'fs';
import inquirer from 'inquirer';
import { FormData } from 'formdata-node';
import { fileFromPath } from 'formdata-node/file-from-path';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import ora from 'ora'; // For progress indicators
import path from 'path';
import os from 'os';
import winston from 'winston'; // For logging
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createCloseAccountInstruction,
} from '@solana/spl-token';
import { fileURLToPath } from 'url';

// If you need __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env file
dotenv.config();

// Configure winston logger
const logger = winston.createLogger({
  level: 'info', // Set the minimum log level
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(), // Log to the console
    new winston.transports.File({ filename: 'bot.log' }), // Log to a file
  ],
});

// Configuration file to store wallets and other data
const CONFIG_FILE = 'wallets.json';

// RPC Endpoint (Replace with your actual RPC endpoint and API key)
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || clusterApiUrl('mainnet-beta');
const connection = new Connection(RPC_ENDPOINT, 'confirmed');

// Maximum number of retries for API requests
const MAX_RETRIES = 5;

// Base delay in milliseconds for exponential backoff
const BASE_DELAY_MS = 500;

// Total token supply
const TOTAL_SUPPLY = 1_000_000_000;

/**
 * Helper function to perform fetch with retries and exponential backoff
 */
async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        // If rate limited, throw an error to trigger retry
        if (response.status === 429) {
          throw new Error('Rate limited');
        }
        return response;
      }
      return response;
    } catch (error) {
      if (attempt < retries) {
        const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
        logger.warn(`Attempt ${attempt} failed. Retrying in ${delay}ms... (${error.message})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw new Error(`Failed after ${retries} attempts: ${error.message}`);
      }
    }
  }
}

/**
 * Load configuration from the config file
 */
function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    const data = fs.readFileSync(CONFIG_FILE);
    return JSON.parse(data);
  }
  return { wallets: [], mintAddress: null };
}

/**
 * Save configuration to the config file
 */
function saveConfig(data) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
}

/**
 * Display a confirmation prompt
 */
async function confirmAction(message) {
  const { confirmation } = await inquirer.prompt({
    type: 'confirm',
    name: 'confirmation',
    message: message,
    default: false,
  });
  return confirmation;
}

/**
 * Create Wallets
 */
async function createWallets() {
  try {
    const config = loadConfig();
    const existingWallets = config.wallets || [];

    const numberOfWalletsPrompt = await inquirer.prompt([
      {
        type: 'input',
        name: 'numberOfWallets',
        message: 'Enter the number of wallets to create (or type "back" to return):',
        validate: (input) => {
          if (input.toLowerCase() === 'back') {
            return true;
          }
          const value = parseInt(input, 10);
          if (Number.isInteger(value) && value > 0) {
            return true;
          }
          return 'Please enter a valid number of wallets or type "back" to return.';
        },
      },
    ]);

    if (numberOfWalletsPrompt.numberOfWallets.toLowerCase() === 'back') {
      return mainMenu();
    }

    const numWallets = parseInt(numberOfWalletsPrompt.numberOfWallets, 10);

    const createDevWalletPrompt = await inquirer.prompt([
      {
        type: 'input',
        name: 'createDevWallet',
        message: 'Do you want to create a Dev Wallet? (yes/no) or type "back" to return:',
        validate: (input) => {
          if (input.toLowerCase() === 'back') {
            return true;
          }
          if (['yes', 'no'].includes(input.toLowerCase())) {
            return true;
          }
          return 'Please enter "yes", "no", or type "back" to return.';
        },
      },
    ]);

    if (createDevWalletPrompt.createDevWallet.toLowerCase() === 'back') {
      return mainMenu();
    }

    const devWalletFlag = createDevWalletPrompt.createDevWallet.toLowerCase() === 'yes';

    const wallets = [];

    const spinner = ora('Creating wallets...').start();
    for (let i = 0; i < numWallets; i++) {
      const keypair = Keypair.generate();
      wallets.push({
        publicKey: keypair.publicKey.toBase58(),
        privateKey: bs58.encode(keypair.secretKey),
        createdAt: new Date().toISOString(), // Save time/date for wallet creation
      });
    }

    if (devWalletFlag) {
      const devKeypair = Keypair.generate();
      wallets.unshift({
        publicKey: devKeypair.publicKey.toBase58(),
        privateKey: bs58.encode(devKeypair.secretKey),
        isDevWallet: true,
        createdAt: new Date().toISOString(), // Save time/date for Dev Wallet
      });
    }

    config.wallets = wallets;
    saveConfig(config);

    spinner.succeed('Wallets created successfully.');
    console.log('Wallets created successfully.');
    logger.info('Wallets created successfully.');

    return mainMenu();
  } catch (error) {
    logger.error(`Error creating wallets: ${error.message}`);
    console.error('Error creating wallets:', error.message);
    return mainMenu();
  }
}

/**
 * Fund Wallets
 */
async function fundWallets() {
  try {
    const config = loadConfig();
    const wallets = config.wallets || [];

    if (wallets.length === 0) {
      logger.info('No wallets found. Please create wallets first.');
      console.log('No wallets found. Please create wallets first.');
      return mainMenu();
    }

    // Ask the user to select a funding wallet or enter a private key
    const fundingWalletChoices = wallets.map((wallet, index) => ({
      name: `${wallet.publicKey}${wallet.isFundingWallet ? ' (Funding Wallet)' : ''}`,
      value: index,
    }));
    fundingWalletChoices.push({ name: 'Enter a private key', value: 'enterPrivateKey' });
    fundingWalletChoices.push({ name: 'Back to main menu', value: 'back' });

    const { fundingWalletSelection } = await inquirer.prompt([
      {
        type: 'list',
        name: 'fundingWalletSelection',
        message: 'Select a funding wallet or enter a private key (or type "back" to return):',
        choices: fundingWalletChoices,
      },
    ]);

    if (fundingWalletSelection === 'back') {
      return mainMenu();
    }

    let fundingKeypair;

    if (fundingWalletSelection === 'enterPrivateKey') {
      const { enteredPrivateKey } = await inquirer.prompt([
        {
          type: 'input',
          name: 'enteredPrivateKey',
          message: 'Enter the funding wallet private key:',
          validate: (input) => {
            try {
              Keypair.fromSecretKey(bs58.decode(input));
              return true;
            } catch (error) {
              return 'Please enter a valid private key.';
            }
          },
        },
      ]);
      fundingKeypair = Keypair.fromSecretKey(bs58.decode(enteredPrivateKey));
    } else {
      const fundingWallet = wallets[fundingWalletSelection];
      fundingKeypair = Keypair.fromSecretKey(bs58.decode(fundingWallet.privateKey));
      // Mark as funding wallet
      wallets[fundingWalletSelection].isFundingWallet = true;
      saveConfig(config);
    }

    // Fetch balances for all wallets
    const walletBalances = {};
    const balancePromises = wallets.map(async (wallet) => {
      const publicKey = new PublicKey(wallet.publicKey);
      const balanceLamports = await connection.getBalance(publicKey);
      walletBalances[wallet.publicKey] = balanceLamports / 1e9; // Convert lamports to SOL
    });
    await Promise.all(balancePromises);

    // Select wallets to fund
    const walletChoices = wallets.map((wallet, index) => ({
      name: `${wallet.publicKey}${wallet.isDevWallet ? ' (Dev Wallet)' : ''} (Balance: ${walletBalances[wallet.publicKey]} SOL)`,
      value: index,
    }));
    walletChoices.push({ name: 'Back to main menu', value: 'back' });

    const { walletIndices } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'walletIndices',
        message: 'Select wallets to fund (or type "back" to return):',
        choices: walletChoices,
        validate: (input) => {
          if (input.includes('back')) {
            return true;
          }
          if (input.length === 0) {
            return 'Please select at least one wallet or type "back" to return.';
          }
          return true;
        },
      },
    ]);

    if (walletIndices.includes('back')) {
      return mainMenu();
    }

    const fundingWalletBalanceLamports = await connection.getBalance(fundingKeypair.publicKey);
    const fundingWalletBalanceSOL = fundingWalletBalanceLamports / 1e9;

    const transfers = [];
    let totalAmount = 0;

    // Ask for amount per wallet, dev wallet first if present
    let devWalletAmount = 0;
    for (const index of walletIndices) {
      const wallet = wallets[index];
      let amount;

      if (wallet.isDevWallet) {
        // Ask for Dev Wallet amount
        const { amountInput } = await inquirer.prompt([
          {
            type: 'input',
            name: 'amountInput',
            message: `Enter the amount of SOL to send to the Dev Wallet (${wallet.publicKey}):`,
            validate: (input) => {
              const value = parseFloat(input);
              if (isNaN(value) || value <= 0) {
                return 'Please enter a valid positive number.';
              }
              return true;
            },
          },
        ]);
        amount = parseFloat(amountInput);
        devWalletAmount = amount;
      } else {
        // For other wallets, default to Dev Wallet amount
        const { amountInput } = await inquirer.prompt([
          {
            type: 'input',
            name: 'amountInput',
            message: `Enter the amount of SOL to send to wallet ${wallet.publicKey} (default is ${devWalletAmount} SOL):`,
            default: devWalletAmount.toString(),
            validate: (input) => {
              const value = parseFloat(input);
              if (isNaN(value) || value <= 0) {
                return 'Please enter a valid positive number.';
              }
              return true;
            },
          },
        ]);
        amount = parseFloat(amountInput);
      }

      transfers.push({
        toPublicKey: wallet.publicKey,
        amount: amount,
      });
      totalAmount += amount;
    }

    // Check if funding wallet has enough
    if (totalAmount > fundingWalletBalanceSOL) {
      console.log(`Insufficient balance in funding wallet. Available: ${fundingWalletBalanceSOL} SOL, Required: ${totalAmount} SOL`);
      logger.error(`Insufficient balance in funding wallet. Available: ${fundingWalletBalanceSOL} SOL, Required: ${totalAmount} SOL`);
      return mainMenu();
    }

    // Confirm transfers
    console.log('\nTransfers to be made:');
    transfers.forEach((transfer, index) => {
      console.log(
        `Transfer ${index + 1}: ${transfer.amount} SOL from ${fundingKeypair.publicKey.toBase58()} to ${transfer.toPublicKey}`
      );
    });

    const confirm = await confirmAction('\nDo you want to proceed with these transfers?');
    if (!confirm) {
      console.log('Transfers canceled.');
      return mainMenu();
    }

    // Prepare transactions
    const spinner = ora('Preparing transfers...').start();
    const encodedTransactions = [];

    // Define the tip account public key
    const tipAccountPubkey = new PublicKey('GkNvGpzptCkN6Hg8ZyxosG8cNKz1A5YZVnZ4dZVNXrZf');
    // Define the tip amount, e.g., 0.000005 SOL
    const tipAmountLamports = 0.000005 * 1e9;

    for (const transfer of transfers) {
      const transaction = new Transaction();

      // Add the transfer instruction
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: fundingKeypair.publicKey,
          toPubkey: new PublicKey(transfer.toPublicKey),
          lamports: Math.round(transfer.amount * 1e9),
        })
      );

      // Add the tip instruction
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: fundingKeypair.publicKey,
          toPubkey: tipAccountPubkey,
          lamports: tipAmountLamports,
        })
      );

      transaction.feePayer = fundingKeypair.publicKey;
      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;

      // Sign
      transaction.sign(fundingKeypair);

      const serializedTransaction = transaction.serialize();
      const encodedTransaction = bs58.encode(serializedTransaction);
      encodedTransactions.push(encodedTransaction);
    }

    spinner.succeed('Transfers prepared successfully.');

    // If multiple wallets, send bundle using Jito
    if (transfers.length > 1) {
      const sendConfirmed = await confirmAction(
        `Are you sure you want to send ${transfers.length} transfers using Jito?`
      );
      if (!sendConfirmed) {
        logger.info('Sending transactions canceled.');
        console.log('Sending transactions canceled.');
        return mainMenu();
      }

      // Send transactions via Jito
      const jitoResponse = await sendTransactionsViaJito(encodedTransactions);
      if (!jitoResponse) return mainMenu();

      // Display transaction signatures
      displayTransactionSignatures(jitoResponse.result);
    } else {
      // Single transfer directly
      const spinner = ora('Transferring SOL...').start();
      try {
        const transaction = new Transaction();

        transaction.add(
          SystemProgram.transfer({
            fromPubkey: fundingKeypair.publicKey,
            toPubkey: new PublicKey(transfers[0].toPublicKey),
            lamports: Math.round(transfers[0].amount * 1e9),
          })
        );

        // Tip instruction
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: fundingKeypair.publicKey,
            toPubkey: tipAccountPubkey,
            lamports: tipAmountLamports,
          })
        );

        const signature = await connection.sendTransaction(transaction, [fundingKeypair]);
        await connection.confirmTransaction(signature, 'confirmed');

        spinner.succeed('Transfer completed successfully.');
        console.log(`Transaction Signature: https://solscan.io/tx/${signature}`);
        logger.info(
          `Transferred ${transfers[0].amount} SOL from ${fundingKeypair.publicKey.toBase58()} to ${transfers[0].toPublicKey}. Transaction: ${signature}`
        );
      } catch (error) {
        spinner.fail('Error during transfer.');
        logger.error(`Error during transfer: ${error.message}`);
        console.error('Error during transfer:', error.message);
      }
    }

    return mainMenu();
  } catch (error) {
    logger.error(`Error during funding wallets: ${error.message}`);
    console.error('Error during funding wallets:', error.message);
    return mainMenu();
  }
}

/**
 * bundleLaunch
 */
async function bundleLaunch() {
  const config = loadConfig();
  const wallets = config.wallets;
  if (!wallets || wallets.length === 0) {
    logger.info('No wallets found. Please create wallets first.');
    console.log('No wallets found. Please create wallets first.');
    return mainMenu();
  }

  try {
    // Step 1: Get Token Metadata
    const tokenMetadata = await getTokenMetadata();
    if (!tokenMetadata) return mainMenu(); // User chose to go back

    // Step 2: Select Dev Wallet
    const devWallet = await selectDevWallet(wallets);
    if (!devWallet) return mainMenu(); // User chose to go back

    // Step 3: Select Buying Wallets
    const buyingWalletIndices = await selectBuyingWallets(wallets, devWallet.index);
    if (buyingWalletIndices === null) return mainMenu();

    // Step 4: Get Buy Percentages (Amounts in Tokens)
    const buyPercentages = await getBuyPercentages(wallets, devWallet.index, buyingWalletIndices);
    if (buyPercentages === null) return mainMenu();

    // Step 5: Upload Metadata
    const metadataUri = await uploadMetadata(tokenMetadata);
    if (!metadataUri) return mainMenu();

    // Step 6: Prepare Transactions
    const { bundledTxArgs, signersList, mintKeypair } = prepareTransactions(
      buyPercentages,
      devWallet,
      wallets,
      metadataUri,
      config,
      tokenMetadata
    );

    // Step 7: Fetch Bundled Transactions
    const transactions = await fetchBundledTransactions(bundledTxArgs);
    if (!transactions) return mainMenu();

    // Step 8: Sign Transactions
    const { encodedSignedTransactions, signatures } = await signTransactions(
      transactions,
      bundledTxArgs,
      signersList
    );

    // Step 9: Confirm and Send Transactions
    const sendConfirmed = await confirmAction(
      `Are you sure you want to send ${encodedSignedTransactions.length} transactions?`
    );
    if (!sendConfirmed) {
      logger.info('Sending transactions canceled.');
      console.log('Sending transactions canceled.');
      return mainMenu();
    }

    // Send transactions via Jito
    const jitoResponse = await sendTransactionsViaJito(encodedSignedTransactions);
    if (!jitoResponse) return mainMenu();

    // Display Transaction Signatures
    displayTransactionSignatures(signatures);

    // Display the mint address after launch
    console.log(`Token Mint Address: ${config.mintAddress}`);
    logger.info(`Token Mint Address: ${config.mintAddress}`);

    return mainMenu();
  } catch (error) {
    logger.error(`Error during bundle launch: ${error.message}`);
    console.error('Error during bundle launch:', error.message);
    return mainMenu();
  }
}

/**
 * getTokenMetadata
 */
async function getTokenMetadata() {
  while (true) {
    try {
      const tokenMetadata = await inquirer.prompt([
        {
          type: 'input',
          name: 'name',
          message: 'Enter the token name (or type "back" to return to main menu):',
          default: 'TEST',
          validate: (input) => {
            if (input.toLowerCase() === 'back') {
              return true;
            }
            if (input.trim() === '') {
              return 'Token name cannot be empty or type "back" to return to the main menu.';
            }
            return true;
          },
        },
        {
          type: 'input',
          name: 'symbol',
          message: 'Enter the token symbol (or type "back" to return to main menu):',
          default: 'AAA',
          validate: (input) => {
            if (input.toLowerCase() === 'back') {
              return true;
            }
            if (input.trim() === '') {
              return 'Token symbol cannot be empty or type "back" to return to the main menu.';
            }
            return true;
          },
        },
        {
          type: 'input',
          name: 'description',
          message: 'Enter the token description (or type "back" to return to main menu):',
          default: 'This is an example token created via PumpPortal.fun',
          validate: (input) => {
            if (input.toLowerCase() === 'back') {
              return true;
            }
            return true;
          },
        },
        {
          type: 'input',
          name: 'twitter',
          message: 'Enter the Twitter link (optional, or type "back" to return to main menu):',
          default: '',
          validate: (input) => {
            if (input.toLowerCase() === 'back') {
              return true;
            }
            return true;
          },
        },
        {
          type: 'input',
          name: 'telegram',
          message: 'Enter the Telegram link (optional, or type "back" to return to main menu):',
          default: '',
          validate: (input) => {
            if (input.toLowerCase() === 'back') {
              return true;
            }
            return true;
          },
        },
        {
          type: 'input',
          name: 'website',
          message: 'Enter the website link (optional, or type "back" to return to main menu):',
          default: '',
          validate: (input) => {
            if (input.toLowerCase() === 'back') {
              return true;
            }
            return true;
          },
        },
        {
          type: 'input',
          name: 'imagePath',
          message: 'Enter the path to the token image file (or type "back" to return to main menu):',
          default: path.join(os.homedir(), 'Downloads', 'your-image.jpg'),
          validate: (input) => {
            if (input.toLowerCase() === 'back') {
              return true;
            }
            if (!fs.existsSync(input)) {
              return 'Image file does not exist. Please enter a valid path or type "back" to return to the main menu.';
            }
            return true;
          },
        },
      ]);

      // Check if the user chose to go back
      if (
        Object.values(tokenMetadata).some(
          (value) => typeof value === 'string' && value.toLowerCase() === 'back'
        )
      ) {
        return null;
      }

      return tokenMetadata;
    } catch (error) {
      logger.error(`Error getting token metadata: ${error.message}`);
      console.error('Error getting token metadata:', error.message);
      const retry = await confirmAction('Do you want to retry entering token metadata?');
      if (!retry) {
        return null;
      }
    }
  }
}

/**
 * selectDevWallet
 */
async function selectDevWallet(wallets) {
  while (true) {
    try {
      const walletsChoices = wallets.map((wallet, index) => ({
        name: wallet.publicKey,
        value: index,
      }));
      const { devWalletIndex } = await inquirer.prompt({
        type: 'list',
        name: 'devWalletIndex',
        message: 'Select the Dev Wallet (to mint the token) (or type "back" to return to main menu):',
        choices: [...walletsChoices, { name: 'Back to main menu', value: 'back' }],
      });

      if (devWalletIndex === 'back') {
        return null;
      }

      const devWallet = {
        ...wallets[devWalletIndex],
        index: devWalletIndex,
      };

      return devWallet;
    } catch (error) {
      logger.error(`Error selecting Dev Wallet: ${error.message}`);
      console.error('Error selecting Dev Wallet:', error.message);
      const retry = await confirmAction('Do you want to retry selecting the Dev Wallet?');
      if (!retry) {
        return null;
      }
    }
  }
}

/**
 * selectBuyingWallets
 */
async function selectBuyingWallets(wallets, devWalletIndex) {
  while (true) {
    try {
      const maxWallets = wallets.length - 1;
      const { numberOfBuyingWallets } = await inquirer.prompt({
        type: 'input',
        name: 'numberOfBuyingWallets',
        message:
          'How many wallets do you want to include in the bundle for buying? (or type "back" to return to main menu):',
        default: Math.min(5, maxWallets).toString(),
        validate: (input) => {
          if (input.toLowerCase() === 'back') {
            return true;
          }
          const value = parseInt(input);
          if (isNaN(value) || value < 1 || value > maxWallets) {
            return `Please enter a number between 1 and ${maxWallets} or type "back" to return to the main menu.`;
          }
          return true;
        },
      });

      if (numberOfBuyingWallets.toLowerCase() === 'back') {
        return null;
      }

      const availableWallets = wallets.filter((_, index) => index !== devWalletIndex);
      const buyingWalletChoices = availableWallets.map((wallet, index) => ({
        name: wallet.publicKey,
        value: index,
      }));

      const { buyingWalletIndices } = await inquirer.prompt({
        type: 'checkbox',
        name: 'buyingWalletIndices',
        message: 'Select the wallets to use for buying (or type "back" to return to main menu):',
        choices: [...buyingWalletChoices, { name: 'Back to main menu', value: 'back' }],
        validate: (input) => {
          if (input.includes('back')) {
            return true;
          }
          if (input.length !== parseInt(numberOfBuyingWallets)) {
            return `Please select exactly ${numberOfBuyingWallets} wallets or type "back" to return to the main menu.`;
          }
          return true;
        },
      });

      if (buyingWalletIndices.includes('back')) {
        return null;
      }

      // Limit to 20 wallets
      if (parseInt(numberOfBuyingWallets) > 20) {
        logger.warn('Limiting to 20 wallets due to API constraints.');
        console.log('Limiting to 20 wallets due to API constraints.');
      }

      return buyingWalletIndices;
    } catch (error) {
      logger.error(`Error selecting buying wallets: ${error.message}`);
      console.error('Error selecting buying wallets:', error.message);
      const retry = await confirmAction('Do you want to retry selecting buying wallets?');
      if (!retry) {
        return null;
      }
    }
  }
}

/**
 * getBuyPercentages
 */
async function getBuyPercentages(wallets, devWalletIndex, buyingWalletIndices) {
  const buyPercentages = [];

  // Prompt for Dev Wallet's buy amount in SOL
  try {
    const { devBuyAmountInSOL } = await inquirer.prompt({
      type: 'input',
      name: 'devBuyAmountInSOL',
      message: `Enter the amount of SOL the Dev Wallet (${wallets[devWalletIndex].publicKey}) wants to spend (enter "0" if not buying):`,
      default: '0',
      validate: (input) => {
        const value = parseFloat(input);
        if (isNaN(value) || value < 0) {
          return 'Please enter a valid positive number for the amount in SOL.';
        }
        return true;
      },
    });

    const devBuyAmountInSOLFloat = parseFloat(devBuyAmountInSOL);
    wallets[devWalletIndex].devBuyAmountInSOL = devBuyAmountInSOLFloat;
  } catch (error) {
    logger.error(`Error getting Dev Wallet buy amount: ${error.message}`);
    console.error(`Error getting Dev Wallet buy amount: ${error.message}`);
    const retry = await confirmAction('Do you want to retry entering the Dev Wallet buy amount?');
    if (retry) {
      return await getBuyPercentages(wallets, devWalletIndex, buyingWalletIndices);
    } else {
      return null;
    }
  }

  // Buying wallets
  for (let i = 0; i < buyingWalletIndices.length; i++) {
    const walletIndex = buyingWalletIndices[i];
    const walletPublicKey = wallets[walletIndex].publicKey;
    try {
      const { percentage } = await inquirer.prompt({
        type: 'input',
        name: 'percentage',
        message: `Enter the percentage of the total supply (${TOTAL_SUPPLY.toLocaleString()}) to buy for wallet ${walletPublicKey} (or type "0" to exclude from bundle):`,
        default: '10',
        validate: (input) => {
          const value = parseFloat(input);
          if (isNaN(value) || value < 0 || value > 100) {
            return 'Please enter a valid percentage between 0 and 100.';
          }
          return true;
        },
      });

      const percentageFloat = parseFloat(percentage);

      if (percentageFloat > 0) {
        const amountInTokens = Math.floor((percentageFloat / 100) * TOTAL_SUPPLY);
        buyPercentages.push({
          type: 'buy',
          publicKey: walletPublicKey,
          amountInTokens: amountInTokens,
          index: walletIndex,
        });
      }
    } catch (error) {
      logger.error(`Error getting buy percentage for wallet ${walletPublicKey}: ${error.message}`);
      console.error(`Error getting buy percentage for wallet ${walletPublicKey}:`, error.message);
      const retry = await confirmAction(
        `Do you want to retry entering the buy percentage for wallet ${walletPublicKey}?`
      );
      if (retry) {
        i--; // retry
      } else {
        return null;
      }
    }
  }

  if (buyPercentages.length === 0) {
    logger.info('No buy transactions to include in the bundle.');
    console.log('No buy transactions to include in the bundle.');
    return null;
  }

  // Check total
  const totalBuyPercentage = buyPercentages.reduce((acc, curr) => {
    return acc + (curr.amountInTokens / TOTAL_SUPPLY) * 100;
  }, 0);

  if (totalBuyPercentage > 100) {
    logger.warn('Total buy percentages exceed 100%. Please adjust the percentages.');
    console.log('Total buy percentages exceed 100%. Please adjust the percentages.');
    return null;
  }

  return buyPercentages;
}

/**
 * uploadMetadata
 */
async function uploadMetadata(tokenMetadata) {
  try {
    const spinner = ora('Uploading token metadata...').start();

    let formData = new FormData();
    const file = await fileFromPath(tokenMetadata.imagePath);
    formData.append('file', file);
    formData.append('name', tokenMetadata.name);
    formData.append('symbol', tokenMetadata.symbol);
    formData.append('description', tokenMetadata.description);
    formData.append('twitter', tokenMetadata.twitter || '');
    formData.append('telegram', tokenMetadata.telegram || '');
    formData.append('website', tokenMetadata.website || '');
    formData.append('showName', 'true');

    const metadataResponse = await fetchWithRetry('https://pump.fun/api/ipfs', {
      method: 'POST',
      body: formData,
    });

    if (!metadataResponse.ok) {
      const errorBody = await metadataResponse.text();
      spinner.fail('Failed to upload metadata.');
      logger.error(`Failed to upload metadata: ${metadataResponse.statusText}`);
      logger.error(`Error Details: ${errorBody}`);
      console.log('Failed to upload metadata:', metadataResponse.statusText);
      console.log('Error Details:', errorBody);

      if (metadataResponse.status >= 500) {
        console.log('Server error. Please try again later.');
        logger.warn('Server error. Please try again later.');
      } else if (metadataResponse.status === 400) {
        console.log('Bad request. Please check your input data.');
        logger.warn('Bad request. Please check your input data.');
      } else {
        console.log('An unexpected error occurred.');
        logger.warn('An unexpected error occurred.');
      }

      return null;
    }

    const metadataResponseJSON = await metadataResponse.json();
    spinner.succeed('Metadata uploaded successfully.');
    logger.info('Metadata uploaded successfully.');
    return metadataResponseJSON.metadataUri;
  } catch (error) {
    logger.error(`Error uploading metadata: ${error.message}`);
    console.error('Error uploading metadata:', error.message);
    const retry = await confirmAction('Do you want to retry uploading the metadata?');
    if (retry) {
      return await uploadMetadata(tokenMetadata);
    } else {
      return null;
    }
  }
}

/**
 * prepareTransactions
 */
function prepareTransactions(buyPercentages, devWallet, wallets, metadataUri, config, tokenMetadata) {
  const bundledTxArgs = [];
  const signersList = [];

  // Generate mint keypair
  const mintKeypair = Keypair.generate();

  // Save to config
  config.mintAddress = mintKeypair.publicKey.toBase58();
  saveConfig(config);

  // "create" transaction
  const createTxArgs = {
    publicKey: devWallet.publicKey,
    action: 'create',
    tokenMetadata: {
      name: tokenMetadata.name,
      symbol: tokenMetadata.symbol,
      uri: metadataUri,
    },
    mint: mintKeypair.publicKey.toBase58(),
    denominatedInSol: 'true',
    slippage: 10,
    priorityFee: 0.0005,
    pool: 'pump',
  };

  if (devWallet.devBuyAmountInSOL > 0) {
    createTxArgs.amount = devWallet.devBuyAmountInSOL;
  } else {
    logger.info('Dev Wallet buy amount is zero. Excluding "amount" from the "create" transaction.');
    console.log('Dev Wallet buy amount is zero. Excluding "amount" from the "create" transaction.');
  }

  bundledTxArgs.push(createTxArgs);

  // Signers for create: [mint, dev]
  signersList.push([
    mintKeypair,
    Keypair.fromSecretKey(bs58.decode(devWallet.privateKey)),
  ]);

  // Buying transactions
  buyPercentages.forEach((buy) => {
    const denominatedInSol = 'false';
    const amount = buy.amountInTokens;

    bundledTxArgs.push({
      publicKey: buy.publicKey,
      action: 'buy',
      mint: mintKeypair.publicKey.toBase58(),
      denominatedInSol: denominatedInSol,
      amount: amount,
      slippage: 10,
      priorityFee: 0.00005,
      pool: 'pump',
    });

    const signerKeypair = Keypair.fromSecretKey(bs58.decode(wallets[buy.index].privateKey));
    signersList.push([signerKeypair]);
  });

  console.log('Bundled Transaction Arguments:', JSON.stringify(bundledTxArgs, null, 2));
  logger.info(`Bundled Transaction Arguments: ${JSON.stringify(bundledTxArgs, null, 2)}`);

  return { bundledTxArgs, signersList, mintKeypair };
}

/**
 * fetchBundledTransactions
 */
async function fetchBundledTransactions(bundledTxArgs) {
  try {
    const spinner = ora('Fetching bundled transactions from PumpPortal.fun...').start();

    const response = await fetchWithRetry('https://pumpportal.fun/api/trade-local', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(bundledTxArgs),
    });

    if (!response.ok) {
      spinner.fail('Error fetching transactions.');
      const errorText = await response.text();
      logger.error(`Error fetching transactions: ${response.statusText} - ${errorText}`);
      console.log('Error fetching transactions:', response.statusText, '-', errorText);
      return null;
    }

    const transactions = await response.json();

    if (!Array.isArray(transactions)) {
      spinner.fail('Unexpected response format from PumpPortal.fun');
      logger.error('Unexpected response format from PumpPortal.fun');
      console.log('Unexpected response format from PumpPortal.fun');
      return null;
    }

    spinner.succeed('Bundled transactions fetched successfully.');
    logger.info('Bundled transactions fetched successfully.');
    return transactions;
  } catch (error) {
    logger.error(`Error fetching bundled transactions: ${error.message}`);
    console.error('Error fetching bundled transactions:', error.message);
    const retry = await confirmAction('Do you want to retry fetching bundled transactions?');
    if (retry) {
      return await fetchBundledTransactions(bundledTxArgs);
    } else {
      return null;
    }
  }
}

/**
 * Updated signTransactions
 * (Using the snippet approach: deserialize → sign → serialize → base58-encode)
 */
async function signTransactions(transactions, bundledTxArgs, signersList) {
  const spinner = ora('Signing transactions...').start();
  let encodedSignedTransactions = [];
  let signatures = [];
  let successfulSignatures = 0;

  for (let i = 0; i < bundledTxArgs.length; i++) {
    try {
      // 1) Deserialize
      const txBase58 = transactions[i];
      const txBuffer = bs58.decode(txBase58);
      const tx = VersionedTransaction.deserialize(new Uint8Array(txBuffer));

      // 2) Sign
      tx.sign(signersList[i]);

      // 3) Serialize & encode
      const serializedTx = tx.serialize();
      const encodedTx = bs58.encode(serializedTx);
      encodedSignedTransactions.push(encodedTx);

      // 4) Store first signature
      signatures.push(bs58.encode(tx.signatures[0]));
      successfulSignatures++;
    } catch (error) {
      logger.error(`Error signing transaction ${i + 1}: ${error.message}`);
      console.error(`Error signing transaction ${i + 1}:`, error.message);
    }
  }

  if (successfulSignatures === bundledTxArgs.length) {
    spinner.succeed('All transactions signed successfully.');
    logger.info('All transactions signed successfully.');
  } else {
    spinner.warn(
      `${successfulSignatures} out of ${bundledTxArgs.length} transactions signed successfully.`
    );
    logger.warn(
      `${successfulSignatures} out of ${bundledTxArgs.length} transactions signed successfully.`
    );
  }

  return { encodedSignedTransactions, signatures };
}

/**
 * sendTransactionsViaJito
 */
async function sendTransactionsViaJito(encodedSignedTransactions) {
  try {
    const spinner = ora('Sending bundled transactions via Jito...').start();

    const jitoResponse = await fetchWithRetry(
      'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendBundle',
          params: [encodedSignedTransactions],
        }),
      }
    );

    const jitoResponseJSON = await jitoResponse.json();

    // Log the entire response
    logger.info(`Jito Response: ${JSON.stringify(jitoResponseJSON)}`);

    // Check for errors
    if (jitoResponseJSON.error) {
      spinner.fail('Error sending bundled transactions via Jito.');
      logger.error(`Jito Response Error: ${JSON.stringify(jitoResponseJSON.error)}`);
      console.error('Jito Response Error:', jitoResponseJSON.error);
      return null;
    }

    spinner.succeed('Bundled transactions sent successfully.');
    console.log('Jito Response:', jitoResponseJSON);
    return jitoResponseJSON;
  } catch (error) {
    logger.error(`Error sending transactions via Jito: ${error.message}`);
    console.error('Error sending transactions via Jito:', error.message);
    const retry = await confirmAction('Do you want to retry sending the transactions?');
    if (retry) {
      return await sendTransactionsViaJito(encodedSignedTransactions);
    } else {
      return null;
    }
  }
}

/**
 * displayTransactionSignatures
 */
function displayTransactionSignatures(signatures) {
  logger.info('Transaction Links:');
  console.log('Transaction Links:');
  signatures.forEach((signature, index) => {
    const link = `Transaction ${index + 1}: https://solscan.io/tx/${signature}`;
    console.log(link);
    logger.info(link);
  });
}

/**
 * Sell Tokens
 */
async function sellTokens() {
  try {
    const config = loadConfig();
    const wallets = config.wallets || [];
    const mintAddress = config.mintAddress;

    if (!mintAddress) {
      logger.error('No mint address found. Please perform a launch first.');
      console.error('No mint address found. Please perform a launch first.');
      return mainMenu();
    }

    if (wallets.length === 0) {
      logger.error('No wallets found. Please create wallets first.');
      console.error('No wallets found. Please create wallets first.');
      return mainMenu();
    }

    const mintPublicKey = new PublicKey(mintAddress);

    // Ask user which wallets to sell from
    const walletChoices = wallets.map((wallet, index) => ({
      name: wallet.publicKey,
      value: index,
    }));
    walletChoices.push({ name: 'Back to main menu', value: 'back' });

    const { walletIndices } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'walletIndices',
        message: 'Select wallets to sell tokens from (or type "back" to return):',
        choices: walletChoices,
        validate: (input) => {
          if (input.includes('back')) {
            return true;
          }
          if (input.length === 0) {
            return 'Please select at least one wallet or type "back" to return.';
          }
          return true;
        },
      },
    ]);

    if (walletIndices.includes('back')) {
      return mainMenu();
    }

    const sellWallets = walletIndices.map((index) => wallets[index]);

    // Prompt for sell percentages
    const sellTransactions = [];
    for (const wallet of sellWallets) {
      const { percentage } = await inquirer.prompt([
        {
          type: 'input',
          name: 'percentage',
          message: `Enter the percentage of tokens to sell from wallet ${wallet.publicKey}:`,
          validate: (input) => {
            const value = parseFloat(input);
            if (isNaN(value) || value <= 0 || value > 100) {
              return 'Please enter a valid percentage between 0 and 100.';
            }
            return true;
          },
        },
      ]);

      sellTransactions.push({
        wallet,
        percentage: parseFloat(percentage),
      });
    }

    // Prepare transactions
    const spinner = ora('Preparing sell transactions...').start();
    const bundledTxArgs = [];
    const signersList = [];

    for (const tx of sellTransactions) {
      const walletPublicKey = tx.wallet.publicKey;
      const walletPrivateKey = tx.wallet.privateKey;
      const percentage = tx.percentage;

      // Fetch token balance
      const associatedTokenAccount = await getAssociatedTokenAddress(
        mintPublicKey,
        new PublicKey(walletPublicKey)
      );

      const tokenAccountInfo = await connection.getParsedAccountInfo(associatedTokenAccount);
      if (!tokenAccountInfo.value) {
        spinner.fail(`No token account found for wallet ${walletPublicKey}.`);
        logger.error(`No token account found for wallet ${walletPublicKey}.`);
        return mainMenu();
      }

      const tokenAmount = tokenAccountInfo.value.data.parsed.info.tokenAmount.uiAmount;
      const sellAmount = (tokenAmount * percentage) / 100;

      bundledTxArgs.push({
        publicKey: walletPublicKey,
        action: 'sell',
        mint: mintAddress,
        amount: sellAmount,
        denominatedInSol: 'false',
        slippage: 10,
        priorityFee: 0.00005,
        pool: 'pump',
      });

      signersList.push([Keypair.fromSecretKey(bs58.decode(walletPrivateKey))]);

      // If account is emptied
      if (percentage === 100) {
        const closeAccountIx = createCloseAccountInstruction(
          associatedTokenAccount,
          new PublicKey(walletPublicKey),
          new PublicKey(walletPublicKey)
        );

        const closeAccountTx = new Transaction().add(closeAccountIx);
        const signature = await connection.sendTransaction(closeAccountTx, [
          Keypair.fromSecretKey(bs58.decode(walletPrivateKey)),
        ]);
        await connection.confirmTransaction(signature, 'confirmed');

        logger.info(
          `Closed token account ${associatedTokenAccount.toBase58()} for wallet ${walletPublicKey}. Transaction: ${signature}`
        );
      }
    }

    spinner.succeed('Sell transactions prepared successfully.');

    // Fetch bundled transactions
    const transactions = await fetchBundledTransactions(bundledTxArgs);
    if (!transactions) return mainMenu();

    // Sign transactions
    const { encodedSignedTransactions, signatures } = await signTransactions(
      transactions,
      bundledTxArgs,
      signersList
    );

    // Confirm and send
    const sendConfirmed = await confirmAction(
      `Are you sure you want to send ${encodedSignedTransactions.length} sell transactions?`
    );
    if (!sendConfirmed) {
      logger.info('Sending transactions canceled.');
      console.log('Sending transactions canceled.');
      return mainMenu();
    }

    // Send via Jito
    const jitoResponse = await sendTransactionsViaJito(encodedSignedTransactions);
    if (!jitoResponse) return mainMenu();

    // Display
    displayTransactionSignatures(signatures);

    return mainMenu();
  } catch (error) {
    logger.error(`Error during selling tokens: ${error.message}`);
    console.error('Error during selling tokens:', error.message);
    return mainMenu();
  }
}

/**
 * manualTrade
 */
async function manualTrade() {
  try {
    const config = loadConfig();
    const wallets = config.wallets || [];
    const mintAddress = config.mintAddress;

    if (!mintAddress) {
      logger.error('No mint address found. Please perform a launch first.');
      console.error('No mint address found. Please perform a launch first.');
      return mainMenu();
    }

    if (wallets.length === 0) {
      logger.error('No wallets found. Please create wallets first.');
      console.error('No wallets found. Please create wallets first.');
      return mainMenu();
    }

    const actionChoices = ['buy', 'sell', 'Back to main menu'];
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'Do you want to buy or sell tokens?',
        choices: actionChoices,
      },
    ]);

    if (action === 'Back to main menu') {
      return mainMenu();
    }

    const walletChoices = wallets.map((wallet, index) => ({
      name: wallet.publicKey,
      value: index,
    }));
    walletChoices.push({ name: 'Back to main menu', value: 'back' });

    const { walletIndex } = await inquirer.prompt([
      {
        type: 'list',
        name: 'walletIndex',
        message: `Select the wallet to ${action} tokens with (or type "back" to return):`,
        choices: walletChoices,
      },
    ]);

    if (walletIndex === 'back') {
      return mainMenu();
    }

    const wallet = wallets[walletIndex];

    const { amount } = await inquirer.prompt([
      {
        type: 'input',
        name: 'amount',
        message: `Enter the amount of ${action === 'buy' ? 'SOL to spend' : 'tokens to sell'}:`,
        validate: (input) => {
          const value = parseFloat(input);
          if (isNaN(value) || value <= 0) {
            return 'Please enter a valid positive number.';
          }
          return true;
        },
      },
    ]);

    const spinner = ora(`Preparing ${action} transaction...`).start();
    const denominatedInSol = action === 'buy' ? 'true' : 'false';

    const bundledTxArgs = [
      {
        publicKey: wallet.publicKey,
        action: action,
        mint: mintAddress,
        amount: parseFloat(amount),
        denominatedInSol: denominatedInSol,
        slippage: 10,
        priorityFee: 0.00005,
        pool: 'pump',
      },
    ];

    const signersList = [Keypair.fromSecretKey(bs58.decode(wallet.privateKey))];

    spinner.succeed(`${action.charAt(0).toUpperCase() + action.slice(1)} transaction prepared successfully.`);

    // Fetch
    const transactions = await fetchBundledTransactions(bundledTxArgs);
    if (!transactions) return mainMenu();

    // Sign
    const { encodedSignedTransactions, signatures } = await signTransactions(
      transactions,
      bundledTxArgs,
      [signersList]
    );

    // Confirm
    const sendConfirmed = await confirmAction(
      `Are you sure you want to send the ${action} transaction?`
    );
    if (!sendConfirmed) {
      logger.info('Sending transaction canceled.');
      console.log('Sending transaction canceled.');
      return mainMenu();
    }

    // Send
    const jitoResponse = await sendTransactionsViaJito(encodedSignedTransactions);
    if (!jitoResponse) return mainMenu();

    // Display
    displayTransactionSignatures(signatures);

    return mainMenu();
  } catch (error) {
    logger.error(`Error during manual trade: ${error.message}`);
    console.error('Error during manual trade:', error.message);
    return mainMenu();
  }
}

/**
 * transferSOL
 */
async function transferSOL() {
  try {
    const config = loadConfig();
    const wallets = config.wallets || [];

    if (wallets.length === 0) {
      logger.error('No wallets found. Please create wallets first.');
      console.error('No wallets found. Please create wallets first.');
      return mainMenu();
    }

    // Fetch balances for all wallets
    const walletBalances = {};
    const balancePromises = wallets.map(async (wallet) => {
      const publicKey = new PublicKey(wallet.publicKey);
      const balanceLamports = await connection.getBalance(publicKey);
      walletBalances[wallet.publicKey] = balanceLamports / 1e9;
    });
    await Promise.all(balancePromises);

    // Select multiple wallets to transfer from
    const walletChoices = wallets.map((wallet, index) => ({
      name: `${wallet.publicKey} (Balance: ${walletBalances[wallet.publicKey]} SOL)`,
      value: index,
    }));
    walletChoices.push({ name: 'Back to main menu', value: 'back' });

    const { fromWalletIndices } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'fromWalletIndices',
        message: 'Select the wallets to transfer SOL from (or type "back" to return):',
        choices: walletChoices,
        validate: (input) => {
          if (!input) {
            return 'Please select at least one wallet or type "back" to return.';
          }
          if (input.includes('back')) {
            return true;
          }
          if (input.length === 0) {
            return 'Please select at least one wallet or type "back" to return.';
          }
          return true;
        },
      },
    ]);

    if (fromWalletIndices && fromWalletIndices.includes('back')) {
      return mainMenu();
    }

    const transfers = [];

    for (const fromWalletIndex of fromWalletIndices) {
      const fromWallet = wallets[fromWalletIndex];
      const fromKeypair = Keypair.fromSecretKey(bs58.decode(fromWallet.privateKey));

      const fromWalletBalanceLamports = await connection.getBalance(fromKeypair.publicKey);
      const fromWalletBalanceSOL = fromWalletBalanceLamports / 1e9;

      // Select target wallet or public key
      const targetWalletChoices = wallets
        .map((wallet, index) => {
          if (index !== fromWalletIndex) {
            return {
              name: `${wallet.publicKey} (Balance: ${walletBalances[wallet.publicKey]} SOL)`,
              value: wallet.publicKey,
            };
          } else {
            return null;
          }
        })
        .filter((choice) => choice !== null);
      targetWalletChoices.push({ name: 'Enter a public key', value: 'enterPublicKey' });
      targetWalletChoices.push({ name: 'Back to main menu', value: 'back' });

      const { toWalletSelection } = await inquirer.prompt([
        {
          type: 'list',
          name: 'toWalletSelection',
          message: `Select the wallet to transfer to from ${fromWallet.publicKey} (or type "back" to return):`,
          choices: targetWalletChoices,
        },
      ]);

      if (toWalletSelection === 'back') {
        return mainMenu();
      }

      let toPublicKey;

      if (toWalletSelection === 'enterPublicKey') {
        const { enteredPublicKey } = await inquirer.prompt([
          {
            type: 'input',
            name: 'enteredPublicKey',
            message: 'Enter the destination public key:',
            validate: (input) => {
              try {
                new PublicKey(input);
                return true;
              } catch (error) {
                return 'Please enter a valid public key.';
              }
            },
          },
        ]);
        toPublicKey = enteredPublicKey;
      } else {
        toPublicKey = toWalletSelection;
      }

      const { amount } = await inquirer.prompt([
        {
          type: 'input',
          name: 'amount',
          message: `Enter the amount of SOL to transfer from ${fromWallet.publicKey} to ${toPublicKey} (Available: ${fromWalletBalanceSOL} SOL):`,
          validate: (input) => {
            const value = parseFloat(input);
            if (isNaN(value) || value <= 0) {
              return 'Please enter a valid positive number.';
            }
            if (value > fromWalletBalanceSOL) {
              return `Insufficient balance. You have ${fromWalletBalanceSOL} SOL available.`;
            }
            return true;
          },
        },
      ]);

      transfers.push({
        fromKeypair,
        toPublicKey,
        amount: parseFloat(amount),
      });
    }

    console.log('\nTransfers to be made:');
    transfers.forEach((transfer, index) => {
      console.log(
        `Transfer ${index + 1}: ${transfer.amount} SOL from ${transfer.fromKeypair.publicKey.toBase58()} to ${transfer.toPublicKey}`
      );
    });

    const confirm = await confirmAction('\nDo you want to proceed with these transfers?');
    if (!confirm) {
      console.log('Transfers canceled.');
      return mainMenu();
    }

    // Perform transfers with retries
    const spinner = ora('Transferring SOL...').start();

    for (const transfer of transfers) {
      let success = false;
      let attempt = 0;
      const maxAttempts = 5;

      while (!success && attempt < maxAttempts) {
        try {
          attempt++;
          // Get blockhash
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

          const transaction = new Transaction({
            recentBlockhash: blockhash,
            feePayer: transfer.fromKeypair.publicKey,
          }).add(
            SystemProgram.transfer({
              fromPubkey: transfer.fromKeypair.publicKey,
              toPubkey: new PublicKey(transfer.toPublicKey),
              lamports: Math.round(transfer.amount * 1e9),
            })
          );

          // Sign
          transaction.sign(transfer.fromKeypair);

          // Send
          const signature = await connection.sendRawTransaction(transaction.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
          });

          const confirmation = await connection.confirmTransaction(
            {
              signature,
              blockhash,
              lastValidBlockHeight,
            },
            'confirmed'
          );

          if (confirmation.value.err) {
            throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
          }

          logger.info(
            `Transferred ${transfer.amount} SOL from ${transfer.fromKeypair.publicKey.toBase58()} to ${transfer.toPublicKey}. Transaction: ${signature}`
          );
          success = true;
        } catch (error) {
          if (error instanceof SendTransactionError) {
            const logs = error.logs;
            logger.error(`Transaction error: ${error.message}`);
            logger.error(`Logs: ${logs.join('\n')}`);
            console.error(`Transaction error: ${error.message}`);
            console.error(`Logs: ${logs.join('\n')}`);
          } else {
            logger.error(`Error during transfer attempt ${attempt}: ${error.message}`);
            console.error(`Error during transfer attempt ${attempt}:`, error.message);
          }

          if (attempt < maxAttempts) {
            const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
            logger.info(`Retrying transfer in ${delay}ms...`);
            await new Promise((resolve) => setTimeout(resolve, delay));
          } else {
            spinner.fail('Transfer failed after multiple attempts.');
            logger.error('Transfer failed after multiple attempts.');
            console.error('Transfer failed after multiple attempts.');
          }
        }
      }
    }

    spinner.succeed('All transfers completed successfully.');
    console.log('All transfers completed successfully.');

    return mainMenu();
  } catch (error) {
    logger.error(`Error during SOL transfer: ${error.message}`);
    console.error('Error during SOL transfer:', error.message);
    return mainMenu();
  }
}

/**
 * Main Menu
 */
async function mainMenu() {
  try {
    const { option } = await inquirer.prompt({
      type: 'list',
      name: 'option',
      message: 'Select an option:',
      choices: [
        'Option 1 - Create wallets',
        'Option 2 - Fund wallets',
        'Option 3 - Bundle a launch',
        'Option 4 - Sell wallets',
        'Option 5 - Manual buy/sell',
        'Option 6 - Transfer SOL',
        'Exit',
      ],
    });

    switch (option) {
      case 'Option 1 - Create wallets':
        await createWallets();
        break;
      case 'Option 2 - Fund wallets':
        await fundWallets();
        break;
      case 'Option 3 - Bundle a launch':
        await bundleLaunch();
        break;
      case 'Option 4 - Sell wallets':
        await sellTokens();
        break;
      case 'Option 5 - Manual buy/sell':
        await manualTrade();
        break;
      case 'Option 6 - Transfer SOL':
        await transferSOL();
        break;
      case 'Exit':
        logger.info('Goodbye!');
        console.log('Goodbye!');
        process.exit(0);
      default:
        logger.warn('Invalid option selected.');
        console.log('Invalid option selected.');
        await mainMenu();
    }
  } catch (error) {
    logger.error(`Error in main menu: ${error.message}`);
    console.error('Error in main menu:', error.message);
    await mainMenu();
  }
}

// Start the bot
mainMenu();

