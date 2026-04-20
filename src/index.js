import 'dotenv/config'

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  getKeyAuthor,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pino from 'pino'
import qrcode from 'qrcode-terminal'

const config = {
  targetGroupJid: cleanEnv('TARGET_GROUP_JID'),
  targetGroupName: cleanEnv('TARGET_GROUP_NAME'),
  pollOptionIndex: Number.parseInt(process.env.POLL_OPTION_INDEX || '0', 10),
  pollOptionText: cleanEnv('POLL_OPTION_TEXT'),
  dryRun: parseBool(process.env.DRY_RUN, false),
  voteDelayMs: Number.parseInt(process.env.VOTE_DELAY_MS || '0', 10),
  ignoreOwnPolls: parseBool(process.env.IGNORE_OWN_POLLS, false),
  sessionDir: process.env.SESSION_DIR || '.session'
}

if (!config.targetGroupJid && !config.targetGroupName) {
  throw new Error('Configura TARGET_GROUP_JID oppure TARGET_GROUP_NAME in .env')
}

if (!Number.isInteger(config.pollOptionIndex) || config.pollOptionIndex < 0) {
  throw new Error('POLL_OPTION_INDEX deve essere un intero >= 0')
}

const logger = pino({ level: process.env.LOG_LEVEL || 'info' })
const messageStore = new Map()
const statePath = path.join(config.sessionDir, 'voted-polls.json')
const votedPolls = await loadVotedPolls()

let sock
let authState
let resolvedTargetGroupJid = config.targetGroupJid

await start()

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(config.sessionDir)
  authState = state
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    logger,
    getMessage: async key => {
      const stored = messageStore.get(messageKeyId(key))
      return stored?.message
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      qrcode.generate(qr, { small: true })
      logger.info('Scansiona il QR con WhatsApp > Dispositivi collegati')
    }

    if (connection === 'open') {
      logger.info(`Connesso come ${sock.user?.id}`)
      resolvedTargetGroupJid = await resolveTargetGroupJid()
      logger.info(`Gruppo monitorato: ${resolvedTargetGroupJid}`)
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error).output.statusCode
      if (statusCode !== DisconnectReason.loggedOut) {
        logger.warn({ statusCode }, 'Connessione chiusa, riconnessione in corso')
        await start()
      } else {
        logger.error('Sessione scollegata da WhatsApp. Elimina .session e rifai il QR.')
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      cacheMessage(msg)
      await handleIncomingMessage(msg).catch(error => {
        logger.error({ error, key: msg.key }, 'Errore durante la gestione del messaggio')
      })
    }
  })
}

async function handleIncomingMessage(msg) {
  if (!resolvedTargetGroupJid || msg.key.remoteJid !== resolvedTargetGroupJid) {
    return
  }

  const content = unwrapMessage(msg.message)
  const poll = getPollCreation(content)
  if (!poll) {
    return
  }

  if (config.ignoreOwnPolls && msg.key.fromMe) {
    logger.info({ id: msg.key.id }, 'Sondaggio ignorato perche creato dal bot')
    return
  }

  const pollId = messageKeyId(msg.key)
  if (votedPolls.has(pollId)) {
    return
  }

  const options = (poll.options || []).map(option => option.optionName || '').filter(Boolean)
  const selectedOption = choosePollOption(options)

  if (!selectedOption) {
    logger.warn({ id: msg.key.id, options }, 'Nessuna opzione sondaggio compatibile con la configurazione')
    return
  }

  if (config.voteDelayMs > 0) {
    await delay(config.voteDelayMs)
  }

  if (config.dryRun) {
    logger.info({ id: msg.key.id, selectedOption }, 'DRY_RUN attivo: voto non inviato')
    votedPolls.add(pollId)
    await saveVotedPolls()
    return
  }

  await votePoll(msg, selectedOption)
  votedPolls.add(pollId)
  await saveVotedPolls()
  logger.info({ id: msg.key.id, selectedOption }, 'Voto sondaggio inviato')
}

async function votePoll(pollMessage, selectedOption) {
  const content = unwrapMessage(pollMessage.message)
  const pollSecret = content?.messageContextInfo?.messageSecret
  if (!pollSecret) {
    throw new Error('Il sondaggio non contiene messageSecret: impossibile cifrare il voto')
  }

  const meId = jidNormalizedUser(authState.creds.me.id)
  const voterJid = getKeyAuthor({ remoteJid: resolvedTargetGroupJid, fromMe: true }, meId)
  const pollCreatorJid = getKeyAuthor(pollMessage.key, meId)
  const vote = encryptPollVote({
    pollCreatorJid,
    pollMsgId: pollMessage.key.id,
    pollEncKey: pollSecret,
    voterJid,
    selectedOptions: [selectedOption]
  })

  const voteMessage = proto.Message.fromObject({
    pollUpdateMessage: {
      pollCreationMessageKey: pollMessage.key,
      vote,
      senderTimestampMs: Date.now()
    }
  })

  await sock.relayMessage(resolvedTargetGroupJid, voteMessage, {
    additionalNodes: [{ tag: 'meta', attrs: { polltype: 'vote' } }]
  })
}

function encryptPollVote({ pollCreatorJid, pollMsgId, pollEncKey, voterJid, selectedOptions }) {
  const selectedOptionHashes = selectedOptions.map(option => sha256(Buffer.from(option)))
  const encodedVote = proto.Message.PollVoteMessage.encode(
    proto.Message.PollVoteMessage.create({
      selectedOptions: selectedOptionHashes
    })
  ).finish()

  const sign = Buffer.concat([
    Buffer.from(pollMsgId),
    Buffer.from(pollCreatorJid),
    Buffer.from(voterJid),
    Buffer.from('Poll Vote'),
    new Uint8Array([1])
  ])

  const key0 = hmacSign(pollEncKey, new Uint8Array(32))
  const encKey = hmacSign(sign, key0)
  const encIv = randomBytes(12)
  const aad = Buffer.from(`${pollMsgId}\u0000${voterJid}`)
  const encPayload = aesEncryptGCM(encodedVote, encKey, encIv, aad)

  return proto.Message.PollEncValue.create({ encPayload, encIv })
}

function choosePollOption(options) {
  if (config.pollOptionText) {
    const wanted = normalizeText(config.pollOptionText)
    return options.find(option => normalizeText(option) === wanted)
  }

  return options[config.pollOptionIndex]
}

async function resolveTargetGroupJid() {
  if (config.targetGroupJid) {
    return config.targetGroupJid
  }

  const groups = await sock.groupFetchAllParticipating()
  const matches = Object.values(groups).filter(group => group.subject === config.targetGroupName)

  if (matches.length === 0) {
    throw new Error(`Nessun gruppo trovato con nome esatto: ${config.targetGroupName}`)
  }

  if (matches.length > 1) {
    const jids = matches.map(group => `${group.subject}: ${group.id}`).join(', ')
    throw new Error(`Nome gruppo ambiguo. Usa TARGET_GROUP_JID. Candidati: ${jids}`)
  }

  return matches[0].id
}

function getPollCreation(content) {
  return content?.pollCreationMessage || content?.pollCreationMessageV2 || content?.pollCreationMessageV3
}

function unwrapMessage(message) {
  let content = message
  for (let i = 0; i < 6; i += 1) {
    if (!content) {
      return content
    }

    const type = getContentType(content)
    const inner = type ? content[type] : undefined
    if (
      inner?.message &&
      (type === 'ephemeralMessage' ||
        type === 'viewOnceMessage' ||
        type === 'viewOnceMessageV2' ||
        type === 'viewOnceMessageV2Extension' ||
        type === 'documentWithCaptionMessage')
    ) {
      content = inner.message
      continue
    }

    return content
  }

  return content
}

function cacheMessage(msg) {
  if (!msg?.key?.id || !msg.message) {
    return
  }

  messageStore.set(messageKeyId(msg.key), msg)
  if (messageStore.size > 5000) {
    const firstKey = messageStore.keys().next().value
    messageStore.delete(firstKey)
  }
}

function messageKeyId(key) {
  return `${key.remoteJid || ''}:${key.id || ''}`
}

async function loadVotedPolls() {
  try {
    const raw = await readFile(statePath, 'utf8')
    const parsed = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed : [])
  } catch {
    return new Set()
  }
}

async function saveVotedPolls() {
  await mkdir(config.sessionDir, { recursive: true })
  await writeFile(statePath, JSON.stringify([...votedPolls], null, 2))
}

function aesEncryptGCM(plaintext, key, iv, additionalData) {
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(additionalData)
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
}

function hmacSign(buffer, key) {
  return createHmac('sha256', key).update(buffer).digest()
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest()
}

function cleanEnv(name) {
  const value = process.env[name]?.trim()
  return value || undefined
}

function parseBool(value, defaultValue) {
  if (value === undefined || value === '') {
    return defaultValue
  }

  return ['1', 'true', 'yes', 'y', 'on'].includes(value.toLowerCase())
}

function normalizeText(value) {
  return value.trim().toLocaleLowerCase('it-IT')
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
