process.on("SIGHUP", () => {});
console.log(`SURVIVOR_READY:${process.pid}`);
setInterval(() => {}, 1000);
