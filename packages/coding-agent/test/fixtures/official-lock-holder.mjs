import lockfile from "proper-lockfile";

const release = await lockfile.lock(process.argv[2], { stale: 10000, update: 2000 });
process.send("locked");
process.once("message", async () => {
	await release();
	process.exit(0);
});