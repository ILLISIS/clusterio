import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import * as lib from "@clusterio/lib";
import * as mock from "../../../test/mock.js";
import controllerEntrypoint from "../dist/node/controller.js";
import { components as allComponents } from "../dist/node/components.js";
import { plugin as info } from "../dist/node/index.js";
import {
	AcquireRequest, DatabaseStatsRequest, DownloadRequest, PrefetchEvent, UploadRequest,
} from "../dist/node/messages.js";

describe("player_sync controller", function() {
	const databaseDir = path.join("temp", "test", "player_sync");

	before(function() {
		try {
			lib.registerPluginMessages([info]);
		} catch (err) {
			// Already registered by the full test suite
		}
	});
	beforeEach(async function() {
		await fs.rm(databaseDir, { recursive: true, force: true });
		await fs.mkdir(databaseDir, { recursive: true });
	});

	async function load() {
		return await mock.loadControllerPlugin(async (context) => {
			context.controller.mockConfigEntries.set("controller.database_directory", databaseDir);
			await controllerEntrypoint(context);
		}, info);
	}

	it("should move inventories.json to player_sync.json", async function() { // Alpha 28
		const playerData = { name: "test", generation: 1 };
		await fs.writeFile(path.join(databaseDir, "inventories.json"), JSON.stringify([["test", playerData]]));

		const controller = await load();
		const stats = await mock.getHandler(controller, DatabaseStatsRequest)();
		assert.equal(stats.databaseEntries, 1);
		assert.equal(stats.largestEntry.name, "test");
		await assert.rejects(fs.access(path.join(databaseDir, "inventories.json")), { code: "ENOENT" });
		await fs.access(path.join(databaseDir, "player_sync.json"));
	});
	it("should not replace an existing player_sync.json", async function() {
		await fs.writeFile(path.join(databaseDir, "inventories.json"), JSON.stringify([["old", { name: "old" }]]));
		await fs.writeFile(path.join(databaseDir, "player_sync.json"), JSON.stringify([["new", { name: "new" }]]));

		const controller = await load();
		const stats = await mock.getHandler(controller, DatabaseStatsRequest)();
		assert.equal(stats.databaseEntries, 1);
		assert.equal(stats.largestEntry.name, "new");
	});

	describe("UploadRequest", function() {
		let controller;
		let disabled;
		beforeEach(async function() {
			disabled = [];
			const stored = { generation: 1, name: "test", force: "player", tag: "stored" };
			await fs.writeFile(path.join(databaseDir, "player_sync.json"), JSON.stringify([["test", stored]]));
			controller = await load();
			controller.instances = new Map([[1, {
				config: {
					get: name => {
						if (name === "instance.name") { return "test instance"; }
						return !disabled.includes(name.replace("player_sync.sync_", ""));
					},
				},
			}]]);
		});

		async function upload(playerData) {
			await mock.getHandler(controller, UploadRequest)({ instanceId: 1, playerName: "test", playerData });
			return (await mock.getHandler(controller, DownloadRequest)({ instanceId: 1, playerName: "test" }))
				.playerData;
		}

		it("should store the upload as is when it has no components", async function() {
			const playerData = { generation: 2, name: "test", force: "enemy", tag: "uploaded" };
			assert.deepEqual(await upload(playerData), playerData);
		});
		it("should merge by the payload's components and ignore the instance config", async function() {
			disabled = ["appearance"];
			const components = Object.fromEntries(Object.keys(allComponents).map(c => [c, c !== "force"]));
			assert.deepEqual(
				await upload({ generation: 2, name: "test", tag: "uploaded", components }),
				{ generation: 2, name: "test", force: "player", tag: "uploaded" },
			);
		});
	});

	describe("UploadRequest with destinationInstanceId", function() {
		// Instances 1-3 run player_sync, 4 is stopped, 5 runs with player_sync off; 1 is the source in every case
		async function setup() {
			const controller = await load();
			for (const [id, status, loadPlugin] of [
				[1, "running", true], [2, "running", true], [3, "running", true],
				[4, "stopped", true], [5, "running", false],
			]) {
				const fields = { "instance.name": `instance ${id}`, "player_sync.load_plugin": loadPlugin };
				controller.instances.records.set(id, { id, status, config: { get: field => fields[field] } });
			}
			const sent = [];
			controller.sendTo = (address, message) => { sent.push({ address, message }); };
			return { controller, sent, upload: mock.getHandler(controller, UploadRequest) };
		}
		const data = generation => ({ name: "test", generation });
		async function stored(controller) {
			return (await mock.getHandler(controller, DownloadRequest)(new DownloadRequest(2, "test"))).playerData;
		}

		it("should send the stored data to a running destination with player_sync on", async function() {
			const { sent, upload } = await setup();
			await upload(new UploadRequest(1, "test", data(1), 2));
			assert.equal(sent.length, 1);
			assert.deepEqual(sent[0].address, { instanceId: 2 });
			assert.ok(sent[0].message instanceof PrefetchEvent);
			assert.deepEqual(sent[0].message.playerData, data(1));
		});
		it("should send the stored copy, with the parts the upload's components left out", async function() {
			const { sent, upload } = await setup();
			await upload(new UploadRequest(1, "test", { ...data(1), force: "player", tag: "first" }));
			const components = Object.fromEntries(Object.keys(allComponents).map(c => [c, c !== "force"]));
			await upload(new UploadRequest(1, "test", { ...data(2), tag: "second", components }, 2));
			assert.equal(sent.length, 1);
			assert.deepEqual(sent[0].message.playerData, { ...data(2), force: "player", tag: "second" });
		});
		it("should send nothing without a destination", async function() {
			const { sent, upload } = await setup();
			await upload(new UploadRequest(1, "test", data(1)));
			assert.equal(sent.length, 0);
		});
		it("should send nothing when an older generation isn't stored", async function() {
			const { sent, upload } = await setup();
			await upload(new UploadRequest(1, "test", data(3)));
			await upload(new UploadRequest(1, "test", data(2), 2));
			assert.equal(sent.length, 0);
		});
		it("should send nothing when another instance's lock rejects the upload", async function() {
			const { controller, sent, upload } = await setup();
			await mock.getHandler(controller, AcquireRequest)(new AcquireRequest(3, "test"));
			await upload(new UploadRequest(1, "test", data(1), 2));
			assert.equal(sent.length, 0);
		});
		it("should store but not send to a stopped, source, plugin-off or unknown instance", async function() {
			const { controller, sent, upload } = await setup();
			let generation = 0;
			for (const id of [4, 1, 5, 99]) {
				generation += 1;
				await upload(new UploadRequest(1, "test", data(generation), id));
			}
			assert.equal(sent.length, 0);
			assert.equal((await stored(controller)).generation, 4);
		});
		it("should store the upload and not fail it when sending throws", async function() {
			const { controller, upload } = await setup();
			controller.sendTo = () => { throw new Error("Host containing instance is not connected"); };
			await upload(new UploadRequest(1, "test", data(1), 2));
			assert.deepEqual(await stored(controller), data(1));
		});
	});
});
