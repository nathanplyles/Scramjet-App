let _CONFIG = {
  prefix: "/scramjet/",
  codec: "plain",
  wispUrl: (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/wisp/",
};
