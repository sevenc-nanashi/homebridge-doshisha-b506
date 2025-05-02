import type {
  AdaptiveLightingController,
  CharacteristicValue,
  PlatformAccessory,
  Service,
} from "homebridge";
import AsyncLock from "async-lock";
import type { MainHomebridgePlatform } from "./platform.js";

const maxBrightness = 10;
const minBrightness = 0;
const minNightBrightness = -2;
const maxNightBrightness = -1;
const minColor = -5;
const maxColor = 5;

const remapInteger = (
  value: number,
  minFrom: number,
  maxFrom: number,
  minTo: number,
  maxTo: number,
): number => {
  const newValue = Math.round(
    ((value - minFrom) / (maxFrom - minFrom)) * (maxTo - minTo) + minTo,
  );
  return Math.max(minTo, Math.min(maxTo, newValue));
};

const remapToIntegers = (
  value: number,
  maps: [from: number, to: number][],
): number => {
  if (value < maps[0][0]) {
    return maps[0][1];
  }
  for (let i = 0; i < maps.length - 1; i++) {
    if (maps[i][0] <= value && value < maps[i + 1][0]) {
      return remapInteger(
        value,
        maps[i][0],
        maps[i + 1][0],
        maps[i][1],
        maps[i + 1][1],
      );
    }
  }
  if (value >= maps[maps.length - 1][0]) {
    return maps[maps.length - 1][1];
  }

  throw new Error("Unreachable");
};

type Signal =
  | "toggle"
  | "allLight"
  | "brighter"
  | "dimmer"
  | "warmer"
  | "cooler"
  | "warm"
  | "cool"
  | "night";

const unstable = "<unstable>";
type Unstable = typeof unstable;
type MaybeUnstable<T> = T | Unstable;
type State = {
  on: MaybeUnstable<"day" | "night" | "off">;
  brightness: MaybeUnstable<number>;
  nightBrightness: MaybeUnstable<number>;
  color: MaybeUnstable<number>;
};
const isUnstable = <T>(value: T | Unstable): value is Unstable => {
  return value === unstable;
};
const stableOr = <T>(value: T | Unstable, defaultValue: T): T => {
  return isUnstable(value) ? defaultValue : value;
};

export class MainPlatformAccessory {
  private service: Service;
  private adaptiveLighting: AdaptiveLightingController;

  private lock = new AsyncLock();

  private config: {
    ip: string;
  } & Record<`${Signal}Signal`, string>;

  constructor(
    private readonly platform: MainHomebridgePlatform,
    private readonly accessory: PlatformAccessory<State>,
  ) {
    this.config = {
      ip: platform.config.ip,
      toggleSignal: platform.config.toggle_signal,
      allLightSignal: platform.config.allLight_signal,
      brighterSignal: platform.config.brighter_signal,
      dimmerSignal: platform.config.dimmer_signal,
      warmerSignal: platform.config.warmer_signal,
      coolerSignal: platform.config.cooler_signal,
      warmSignal: platform.config.warm_signal,
      coolSignal: platform.config.cool_signal,
      nightSignal: platform.config.night_signal,
    };
    // biome-ignore lint/style/noNonNullAssertion: <explanation>
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, "Doshisha")
      .setCharacteristic(this.platform.Characteristic.Model, "B506");

    this.accessory.context = {
      on: this.accessory.context.on ?? unstable,
      brightness: this.accessory.context.brightness ?? unstable,
      nightBrightness: this.accessory.context.nightBrightness ?? unstable,
      color: this.accessory.context.color ?? unstable,
    };

    this.service =
      this.accessory.getService(this.platform.Service.Lightbulb) ||
      this.accessory.addService(this.platform.Service.Lightbulb);

    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      platform.config.name as string,
    );

    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(this.setBrightness.bind(this))
      .onGet(this.getBrightness.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.ColorTemperature)
      .onSet(this.setColor.bind(this))
      .onGet(this.getColor.bind(this));

    this.adaptiveLighting =
      new this.platform.api.hap.AdaptiveLightingController(this.service);
    this.accessory.configureController(this.adaptiveLighting);
  }

  async setOn(value: CharacteristicValue) {
    const isOn = value as boolean;
    await this.lock.acquire("", async () => {
      this.platform.log.info(
        `Requested setOn: ${this.accessory.context.on} -> ${isOn}`,
      );
      if (isUnstable(this.accessory.context.on)) {
        if (isOn) {
          await this.triggerSignal("allLight");
          this.accessory.context.on = "day";
          this.accessory.context.brightness = 10;
          this.accessory.context.color = 0;
        } else {
          await this.triggerSignal("night");
          await this.triggerSignal("toggle");
          this.accessory.context.on = "off";
        }
      } else if (
        isOn &&
        (isUnstable(this.accessory.context.brightness) ||
          isUnstable(this.accessory.context.color))
      ) {
        await this.triggerSignal("allLight");
        this.accessory.context.brightness = 10;
        this.accessory.context.color = 0;
      } else if (isOn && this.accessory.context.on === "off") {
        await this.triggerSignal("toggle");
        this.accessory.context.on = "day";
      } else if (!isOn && this.accessory.context.on !== "off") {
        await this.triggerSignal("toggle");
        this.accessory.context.on = "off";
      }
    });
  }

  async getOn(): Promise<CharacteristicValue> {
    this.platform.log.info(`Requested getOn: ${this.accessory.context.on}`);
    return (
      this.accessory.context.on === "day" ||
      this.accessory.context.on === "night"
    );
  }

  async setBrightness(value: CharacteristicValue) {
    await this.lock.acquire("", async () => {
      const brightness = value as number;
      const divs = remapInteger(
        brightness,
        0,
        100,
        minBrightness + minNightBrightness,
        maxBrightness,
      );
      this.platform.log.info(
        `Translating brightness: ${brightness} -> ${divs}`,
      );
      this.platform.log.info(
        `Requested setBrightness: ${this.accessory.context.brightness}/${this.accessory.context.nightBrightness}@${this.accessory.context.on} -> ${divs}`,
      );
      if (divs < 0) {
        if (
          isUnstable(this.accessory.context.on) ||
          isUnstable(this.accessory.context.brightness)
        ) {
          await this.triggerSignal("night");
          await this.triggerSignal("toggle");
          this.accessory.context.on = "off";
        }
        if (
          this.accessory.context.on === "off" ||
          this.accessory.context.on === "day"
        ) {
          await this.triggerSignal("night");
          this.accessory.context.on = "night";
          this.accessory.context.nightBrightness = -1;
        }
        if (
          isUnstable(this.accessory.context.nightBrightness) &&
          this.accessory.context.on === "night"
        ) {
          await this.triggerSignal("toggle");
          await this.triggerSignal("night");
          this.accessory.context.nightBrightness = -1;
        }
        if (this.accessory.context.nightBrightness !== divs) {
          await this.triggerSignal("night");
          this.accessory.context.nightBrightness = divs;
        }
      } else if (divs >= 0) {
        if (
          isUnstable(this.accessory.context.on) ||
          isUnstable(this.accessory.context.brightness)
        ) {
          await this.triggerSignal("allLight");
          this.accessory.context.on = "day";
          this.accessory.context.brightness = 10;
          this.accessory.context.color = 0;
        }
        if (this.accessory.context.on === "off") {
          await this.triggerSignal("toggle");
          this.accessory.context.on = "day";
        }
        if (this.accessory.context.on === "night") {
          await this.triggerSignal("toggle");
          await this.triggerSignal("toggle");
          this.accessory.context.on = "day";
        }
        if (isUnstable(this.accessory.context.brightness)) {
          await this.triggerSignal("allLight");
          this.accessory.context.brightness = 10;
        }
        for (let i = this.accessory.context.brightness; i < divs; i++) {
          await this.triggerSignal("brighter");
          this.accessory.context.brightness += 1;
        }
        for (let i = this.accessory.context.brightness; i > divs; i--) {
          await this.triggerSignal("dimmer");
          this.accessory.context.brightness -= 1;
        }
      }
    });
  }

  async getBrightness(): Promise<CharacteristicValue> {
    this.platform.log.info(
      `Requested getBrightness: ${this.accessory.context.brightness}`,
    );
    if (isUnstable(this.accessory.context.on)) {
      return 0;
    }
    if (this.accessory.context.on === "night") {
      return remapInteger(
        stableOr(this.accessory.context.nightBrightness, 0),
        minBrightness + minNightBrightness,
        maxBrightness,
        0,
        100,
      );
    }
    if (this.accessory.context.on === "day") {
      return remapInteger(
        stableOr(this.accessory.context.brightness, 0),
        minBrightness,
        maxBrightness,
        0,
        100,
      );
    }

    if (this.accessory.context.on === "off") {
      return 0;
    }

    return 0;
  }

  async setColor(value: CharacteristicValue) {
    if (
      isUnstable(this.accessory.context.on) ||
      isUnstable(this.accessory.context.color)
    ) {
      await this.triggerSignal("allLight");
      this.accessory.context.on = "day";
      this.accessory.context.brightness = 10;
      this.accessory.context.color = 0;
    }
    const hapColor = value as number;
    const color = remapToIntegers(hapColor, [
      [144, -5],
      [172, -3],
      [222, 0],
      [303, 3],
      [400, 5],
    ]);
    this.platform.log.info(`Translating color: ${hapColor} -> ${color}`);
    this.platform.log.info(
      `Requested setColor: ${this.accessory.context.color} -> ${color}`,
    );

    if (
      color === minColor &&
      this.accessory.context.color !== minColor &&
      this.accessory.context.brightness === 10
    ) {
      await this.triggerSignal("cool");
      this.accessory.context.on = "day";
      this.accessory.context.color = minColor;
      this.accessory.context.brightness = 10;
    } else if (
      color === 0 &&
      this.accessory.context.color !== 0 &&
      this.accessory.context.brightness === 10
    ) {
      await this.triggerSignal("allLight");
      this.accessory.context.on = "day";
      this.accessory.context.color = maxColor;
      this.accessory.context.brightness = 10;
    } else if (
      color === maxColor &&
      this.accessory.context.color !== maxColor &&
      this.accessory.context.brightness === 10
    ) {
      await this.triggerSignal("warm");
      this.accessory.context.on = "day";
      this.accessory.context.color = maxColor;
      this.accessory.context.brightness = 10;
    } else if (color !== this.accessory.context.color) {
      for (let i = this.accessory.context.color; i < color; i++) {
        await this.triggerSignal("warmer");
        this.accessory.context.color += 1;
      }
      for (let i = this.accessory.context.color; i > color; i--) {
        await this.triggerSignal("cooler");
        this.accessory.context.color -= 1;
      }
    }
  }

  async getColor(): Promise<CharacteristicValue> {
    this.platform.log.info(
      `Requested getColor: ${this.accessory.context.color}`,
    );
    const color = stableOr(this.accessory.context.color, 0);
    const hapColor = remapInteger(color, minColor, maxColor, 144, 400);
    return hapColor;
  }

  private async triggerSignal(signal: Signal) {
    const signalPayload = this.config[`${signal}Signal`];
    this.platform.log.info(`Triggering signal: ${signal}`);

    await fetch(`http://${this.config.ip}/messages`, {
      method: "POST",
      body: signalPayload,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Requested-With": "fetch",
      },
    })
      .then((response) => {
        if (!response.ok) {
          this.platform.log.error(
            `Error sending signal: ${response.statusText}`,
          );

          throw new Error(`Error sending signal: ${response.statusText}`);
        }
        this.platform.log.info("Signal sent successfully");
        return response.json();
      })
      .catch((error) => {
        this.platform.log.error(`Error sending signal: ${error}`);

        throw new this.platform.api.hap.HapStatusError(
          this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
        );
      });
  }
}
