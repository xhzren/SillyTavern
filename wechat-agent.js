import { Client } from '@modelcontextprotocol/sdk/client.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const POLL_INTERVAL = 10000; // 10 seconds

const repliedMessages = new Set();

/**
 * Create MCP client connected to wechat server
 */
async function createWeChatClient() {
  const transport = new StdioClientTransport({
    command: 'bunx',
    args: ['mcp-wechat-server']
  });

  const client = new Client({
    name: 'wechat-auto-reply-agent',
    version: '1.0.0'
  }, {
    capabilities: {}
  });

  await client.connect(transport);
  return client;
}

/**
 * Fetch new messages from WeChat via MCP
 */
async function pollMessages(client) {
  try {
    const result = await client.callTool({
      name: 'get_messages',
      arguments: { timeout: 5000, wait: false }
    });
    return result.content?.[0]?.text ? JSON.parse(result.content[0].text) : { messages: [] };
  } catch (error) {
    console.error('[WeChat Agent] Failed to poll messages:', error.message);
    return { messages: [] };
  }
}

/**
 * Send typing indicator
 */
async function sendTyping(client, toUserId, status) {
  try {
    await client.callTool({
      name: 'send_typing',
      arguments: { status, to: toUserId }
    });
  } catch (error) {
    console.error('[WeChat Agent] Failed to send typing:', error.message);
  }
}

/**
 * Send text message
 */
async function sendTextMessage(client, toUserId, text) {
  try {
    await client.callTool({
      name: 'send_text_message',
      arguments: { text, to: toUserId }
    });
  } catch (error) {
    console.error('[WeChat Agent] Failed to send message:', error.message);
  }
}

/**
 * Generate response using Claude LLM
 */
async function generateResponse(messageTexts) {
  if (!ANTHROPIC_API_KEY) {
    return 'Sorry, AI service is not configured.';
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6-20250514',
      max_tokens: 1024,
      messages: messageTexts.map(text => ({ role: 'user', content: text }))
    })
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

/**
 * Process a single message
 */
async function processMessage(client, message) {
  const { message_id, from_user_id, text } = message;

  if (repliedMessages.has(message_id)) {
    return;
  }
  repliedMessages.add(message_id);

  // Limit set size to prevent memory leak
  if (repliedMessages.size > 1000) {
    const entries = Array.from(repliedMessages);
    entries.slice(0, 500).forEach(id => repliedMessages.delete(id));
  }

  await sendTyping(client, from_user_id, 'typing');

  try {
    const response = await generateResponse([text]);
    await sendTextMessage(client, from_user_id, response);
  } catch (error) {
    console.error('[WeChat Agent] Error generating response:', error.message);
    await sendTextMessage(client, from_user_id, 'Sorry, I encountered an error.');
  } finally {
    await sendTyping(client, from_user_id, 'cancel');
  }
}

/**
 * Main polling loop
 */
async function main() {
  console.log('[WeChat Agent] Starting...');

  const client = await createWeChatClient();
  console.log('[WeChat Agent] Connected to WeChat MCP server');

  while (true) {
    try {
      const { messages } = await pollMessages(client);
      for (const message of messages) {
        await processMessage(client, message);
      }
    } catch (error) {
      console.error('[WeChat Agent] Polling error:', error.message);
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }
}

main().catch(console.error);
