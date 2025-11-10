import fs from "node:fs";
import { dequal } from "dequal";

const serverIp = process.argv[2];
if (!serverIp) {
	throw new Error("Please provide the server IP as a command line argument.");
}

const signals = {
	toggle: "消灯/普段灯",
	allLight: "全灯",
	brighter: "明るく",
	dimmer: "暗く",
	warmer: "くつろぎ>",
	cooler: "<さわやか",
	warm: "くつろぎ",
	cool: "さわやか",
	night: "常夜灯",
};

const fetchMessages = async () => {
	const messageUrl = `http://${serverIp}/messages`;
	const response = await fetch(messageUrl, {
		headers: {
			"X-Requested-With": "fetch",
		},
	});
	if (!response.ok) {
		throw new Error(`Error fetching messages: ${response.statusText}`);
	}
	return response.json();
};

const allSignals: Record<string, string> = {};
let previousState = await fetchMessages();
for (const [signalName, label] of Object.entries(signals)) {
	console.log(`Waiting for signal: ${label}`);
	while (true) {
		const currentState = await fetchMessages();
		if (!dequal(previousState, currentState)) {
			console.log(`Signal received: ${label}`);
			allSignals[`${signalName}_signal`] = JSON.stringify(currentState);
			previousState = currentState;
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
}

console.log("All signals received");
const config = JSON.stringify(
	{
		platform: "HomebridgeDoshishaB506",
		name: "照明",
		ip: serverIp,
		...allSignals,
	},
	null,
	2,
);
await fs.promises.writeFile("config.json", config);
