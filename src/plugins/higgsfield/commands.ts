import { Command } from 'commander';
import { randomUUID } from 'crypto';
import { createClientGetter } from '../../utils/client-factory';
import { addExamples } from '../../utils/command-tree';
import { CliError, handleError } from '../../utils/errors';
import { addJsonOption, writeJson } from '../../utils/output';
import { createProfileCommands } from '../../utils/profile-commands';
import { enforceWriteAccess } from '../../utils/read-only';
import type { InputSpec, SetupContext, SetupResult } from '../../plugin-sdk';
import { addProfileWithSetup } from '../profile-host';
import { checkAnswer } from '../setup-inputs';
import type { ProfileAddOptions } from '../types';
import { buildBody, mediaTypeOf, uploadLocalFiles, type Body } from './body';
import { HiggsfieldClient, parseKey, parseModelId } from './client';
import { failureOf, isTerminal, noteStatus, outputUrls, readRecords, saveOutputs, saveRecord, submit, waitFor } from './requests';
import type { HiggsfieldCredentials, RequestStatus } from './types';

const KEY_INPUT: InputSpec = { label: 'API key', kind: 'secret', help: 'console.higgsfield.ai → API keys, as <key id>:<key secret>' };

const getClient = createClientGetter<HiggsfieldCredentials, HiggsfieldClient>({
  service: 'higgsfield',
  createClient: (credentials) => new HiggsfieldClient(credentials),
});

export interface HiggsfieldProfileAddOptions extends ProfileAddOptions {
  key?: string;
}

export async function higgsfieldProfileAdd(
  options: HiggsfieldProfileAddOptions,
  context: SetupContext,
  baseUrl?: string,
): Promise<SetupResult<HiggsfieldCredentials>> {
  const key = parseKey(options.key !== undefined ? checkAnswer(KEY_INPUT, options.key) : await context.ask(KEY_INPUT));
  await new HiggsfieldClient({ key }, baseUrl).checkKey();
  return { credentials: { key }, suggestedProfileName: 'default', info: 'Higgsfield accepted the API key' };
}

/** The key id, shortened: enough to tell keys apart, never the secret. */
export function describeKey(credentials: HiggsfieldCredentials): string {
  const id = credentials.key.split(':')[0];
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

const stderr = (line: string) => process.stderr.write(`${line}\n`);
const PROFILE_OPTION = ['--profile <name>', 'Profile name (optional if only one profile exists)'] as const;
const collect = (value: string, previous: string[] = []) => [...previous, value];

interface BodyOptions { arg?: string[]; jsonBody?: string }

function addBodyOptions(cmd: Command): Command {
  return cmd
    .option('--arg <key=value>', 'A body field; repeat it. A repeated key, or key[]=value, makes an array; true, false, null, numbers and [..]/{..} JSON are typed; a local .jpg/.jpeg/.png/.webp/.gif/.wav/.mp4 path is uploaded and replaced by its URL', collect)
    .option('--json-body <file>', 'The body as a JSON object, from a file or - for stdin; --arg fields replace its keys');
}

/** The body with every local media file uploaded and replaced by its URL. */
async function preparedBody(client: HiggsfieldClient, options: BodyOptions): Promise<Body> {
  const { body, uploaded } = await uploadLocalFiles(buildBody(options), (path, type) => client.upload(Bun.file(path), type));
  for (const { path, url } of uploaded) stderr(`Uploaded ${path} → ${url}`);
  return body;
}

interface StatusView {
  requestId: string;
  status: string;
  error?: string;
  outputs: string[];
  saved?: string[];
  expiresAt?: string;
}

function view(status: RequestStatus, saved?: string[]): StatusView {
  const v: StatusView = { requestId: status.request_id, status: status.status, outputs: outputUrls(status) };
  if (status.error) v.error = status.error;
  if (saved) v.saved = saved;
  if (typeof status.expires_at === 'string') v.expiresAt = status.expires_at;
  return v;
}

function printView(v: StatusView, json?: boolean): void {
  if (json) { writeJson(v, 2); return; }
  console.log(`Request: ${v.requestId}`);
  console.log(`  Status: ${v.status}`);
  if (v.error) console.log(`  Error: ${v.error}`);
  for (const path of v.saved ?? []) console.log(`  Saved: ${path}`);
  if (!v.saved) for (const url of v.outputs) console.log(`  Output: ${url}`);
  if (v.expiresAt) console.log(`  Expires: ${v.expiresAt}`);
}

/** Prints a finished request, saved when it completed; an error for failed, nsfw and canceled. */
async function finish(client: HiggsfieldClient, profile: string, status: RequestStatus, output: string | undefined, json?: boolean): Promise<void> {
  const failure = failureOf(status);
  const saved = failure ? undefined : await saveOutputs(client, status, output);
  await noteStatus(profile, status, saved);
  if (failure) {
    if (json) printView(view(status), true);
    throw failure;
  }
  printView(view(status, saved), json);
}

export function registerHiggsfieldCommands(program: Command): void {
  const hf = program.command('higgsfield').description('Generate images, videos and audio with any Higgsfield API model: upload inputs, submit, wait, save the results');

  addExamples(
    addJsonOption(
      addBodyOptions(
        hf
          .command('run')
          .description('Submit a generation to a model, then wait for it and save its outputs (here by default). Local media files in the body are uploaded first')
          .argument('<model-id>', 'The model endpoint, such as higgsfield-ai/soul/v2/standard (listed at console.higgsfield.ai)'),
      )
        .option('--no-wait', 'Only submit and print the request id; save the outputs later with fetch')
        .option('-o, --output <path>', 'A folder (existing, or ending in /) or a file name for the outputs (default: the current folder)')
        .option(...PROFILE_OPTION),
    ).action(async (modelId: string, options: BodyOptions & { wait?: boolean; output?: string; profile?: string; json?: boolean }) => {
      try {
        const model = parseModelId(modelId);
        const { client, profile } = await getClient(options.profile);
        await enforceWriteAccess('higgsfield', profile, 'submit generations');
        const body = await preparedBody(client, options);
        const accepted = await submit(client, model, body, randomUUID(), stderr);
        await saveRecord(profile, { requestId: accepted.request_id, model, createdAt: new Date().toISOString(), status: accepted.status });
        if (options.wait === false) {
          if (options.json) writeJson({ requestId: accepted.request_id, status: accepted.status }, 2);
          else console.log(accepted.request_id);
          return;
        }
        stderr(`Submitted ${accepted.request_id}, waiting (Ctrl-C leaves it running; fetch it later)`);
        await finish(client, profile, await waitFor(client, accepted.request_id, stderr), options.output, options.json);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  # text to image
  agentio higgsfield run higgsfield-ai/soul/v2/standard --arg prompt="Editorial portrait in soft daylight"

  # local files are uploaded first; a repeated key makes an array
  agentio higgsfield run higgsfield/genjutsu/motion-transfer/v1.0 \\
    --arg video_url=./clip.mp4 --arg image_urls=./face1.jpg --arg image_urls=./face2.jpg \\
    --arg resolution=720p -o ~/Videos/

  # one image in a one-item array, a number, and the rest of the body from a file
  agentio higgsfield run some/model --json-body body.json --arg 'image_urls[]=face.png' --arg duration=5

  # submit only, save later
  agentio higgsfield run some/model --arg prompt="..." --no-wait
  agentio higgsfield fetch <request-id>`,
  );

  addExamples(
    addJsonOption(
      addBodyOptions(
        hf
          .command('estimate')
          .description('Ask what a generation would cost, without submitting it (POST /estimate). Local media files in the body are uploaded first')
          .argument('<model-id>', 'The model endpoint'),
      ).option(...PROFILE_OPTION),
    ).action(async (modelId: string, options: BodyOptions & { profile?: string; json?: boolean }) => {
      try {
        const model = parseModelId(modelId);
        const { client } = await getClient(options.profile);
        const estimate = await client.estimate(model, await preparedBody(client, options));
        if (options.json) { writeJson(estimate, 2); return; }
        if (typeof estimate.usd === 'string' || typeof estimate.usd === 'number') console.log(`$${estimate.usd}`);
        else if (typeof estimate.pricing_description === 'string') console.log(estimate.pricing_description);
        else writeJson(estimate, 2);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  agentio higgsfield estimate higgsfield-ai/soul/v2/standard --arg prompt="A lighthouse at dusk"`,
  );

  addExamples(
    addJsonOption(
      hf
        .command('upload')
        .description('Upload local media to Higgsfield storage and print each public URL, for use in a body')
        .argument('<file...>', 'JPEG, PNG, WebP, GIF, WAV or MP4 files')
        .option(...PROFILE_OPTION),
    ).action(async (files: string[], options: { profile?: string; json?: boolean }) => {
      try {
        for (const file of files) if (!mediaTypeOf(file)) throw new CliError('INVALID_PARAMS', `Higgsfield does not take ${file}`, 'Upload .jpg, .jpeg, .png, .webp, .gif, .wav or .mp4 files');
        const { client, profile } = await getClient(options.profile);
        await enforceWriteAccess('higgsfield', profile, 'upload files');
        const { uploaded } = await uploadLocalFiles({ files }, (path, type) => client.upload(Bun.file(path), type));
        if (options.json) writeJson(uploaded, 2);
        else for (const { url } of uploaded) console.log(url);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  agentio higgsfield upload face.jpg clip.mp4`,
  );

  addExamples(
    addJsonOption(
      hf
        .command('status')
        .description('Show where a request stands and its output URLs')
        .argument('<request-id>', 'The id run printed')
        .option('--follow', 'Wait until it is completed, failed, nsfw or canceled')
        .option(...PROFILE_OPTION),
    ).action(async (requestId: string, options: { follow?: boolean; profile?: string; json?: boolean }) => {
      try {
        const { client, profile } = await getClient(options.profile);
        const status = options.follow ? await waitFor(client, requestId, stderr) : await client.status(requestId);
        await noteStatus(profile, status);
        printView(view(status), options.json);
        if (options.follow) { const failure = failureOf(status); if (failure) throw failure; }
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  agentio higgsfield status d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff --follow`,
  );

  addExamples(
    addJsonOption(
      hf
        .command('fetch')
        .description('Save the outputs of a completed request (kept by Higgsfield for at least 7 days)')
        .argument('<request-id>', 'The id run printed')
        .option('-o, --output <path>', 'A folder (existing, or ending in /) or a file name (default: the current folder)')
        .option('--wait', 'Wait for the request to finish first')
        .option(...PROFILE_OPTION),
    ).action(async (requestId: string, options: { output?: string; wait?: boolean; profile?: string; json?: boolean }) => {
      try {
        const { client, profile } = await getClient(options.profile);
        const status = options.wait ? await waitFor(client, requestId, stderr) : await client.status(requestId);
        if (!isTerminal(status)) throw new CliError('INVALID_PARAMS', `Request ${requestId} is ${status.status}`, `Wait for it: agentio higgsfield fetch ${requestId} --wait`);
        await finish(client, profile, status, options.output, options.json);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  agentio higgsfield fetch d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff -o ~/Pictures/`,
  );

  addExamples(
    addJsonOption(
      hf
        .command('cancel')
        .description('Cancel a request that is still queued (a started one cannot be canceled)')
        .argument('<request-id>', 'The id run printed')
        .option(...PROFILE_OPTION),
    ).action(async (requestId: string, options: { profile?: string; json?: boolean }) => {
      try {
        const { client, profile } = await getClient(options.profile);
        await enforceWriteAccess('higgsfield', profile, 'cancel requests');
        await client.cancel(requestId);
        await saveRecord(profile, { requestId, status: 'canceled' });
        if (options.json) writeJson({ requestId, status: 'canceled' }, 2);
        else console.log(`Canceled ${requestId}`);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  agentio higgsfield cancel d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff`,
  );

  addExamples(
    addJsonOption(
      hf
        .command('delete')
        .description("Delete a finished request's files, prompt and parameters at Higgsfield now (billing records stay)")
        .argument('<request-id>', 'The id run printed')
        .option(...PROFILE_OPTION),
    ).action(async (requestId: string, options: { profile?: string; json?: boolean }) => {
      try {
        const { client, profile } = await getClient(options.profile);
        await enforceWriteAccess('higgsfield', profile, 'delete requests');
        await client.delete(requestId);
        if (options.json) writeJson({ requestId, status: 'deleted' }, 2);
        else console.log(`Deleted ${requestId} at Higgsfield`);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  agentio higgsfield delete d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff`,
  );

  addExamples(
    addJsonOption(
      hf
        .command('list')
        .description('List the requests submitted from this computer, newest first (kept locally: the API cannot list requests). Statuses are as last seen')
        .option('--limit <n>', 'At most this many', '20')
        .option(...PROFILE_OPTION),
    ).action(async (options: { limit: string; profile?: string; json?: boolean }) => {
      try {
        const limit = Number(options.limit);
        if (!Number.isInteger(limit) || limit < 1) throw new CliError('INVALID_PARAMS', '--limit must be a positive whole number');
        const { profile } = await getClient(options.profile);
        const records = (await readRecords(profile)).slice(0, limit);
        if (options.json) { writeJson(records, 2); return; }
        if (records.length === 0) { console.log('No requests'); return; }
        for (const r of records) {
          console.log(`[${r.status}] ${r.requestId} ${r.model} ${r.createdAt}`);
          if (r.error) console.log(`  Error: ${r.error}`);
          for (const path of r.outputs ?? []) console.log(`  Saved: ${path}`);
        }
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  agentio higgsfield list --limit 5`,
  );

  const profile = createProfileCommands<HiggsfieldCredentials>(hf, {
    service: 'higgsfield',
    displayName: 'Higgsfield',
  });

  addExamples(
    profile
      .command('add')
      .description('Add a Higgsfield API key')
      .option('--key <id:secret>', 'API key (asked for when absent, which keeps it out of shell history)')
      .option('--profile <name>', 'Profile name (default: default)')
      .option('--read-only', 'Create as read-only profile (blocks write operations)')
      .action(async (options: HiggsfieldProfileAddOptions) => {
        try {
          await addProfileWithSetup('higgsfield', (o, context) => higgsfieldProfileAdd(o as HiggsfieldProfileAddOptions, context), options);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # asks for the key
  agentio higgsfield profile add`,
  );
}
