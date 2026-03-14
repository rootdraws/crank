(function(){
  var el = document.getElementById('asciiCat');
  if (!el) return;

  var sit = [
    "    /\\_____/\\",
    "   /  o   o  \\",
    "  ( ==  ^  == )",
    "   )         (",
    "  (           )",
    " ( (  )   (  ) )",
    "(__(__)___(__)__)",
  ];

  var blink = [
    "    /\\_____/\\",
    "   /  -   -  \\",
    "  ( ==  ^  == )",
    "   )         (",
    "  (           )",
    " ( (  )   (  ) )",
    "(__(__)___(__)__)",
  ];

  var lick = [
    "    /\\_____/\\",
    "   /  o   o  \\",
    "  ( ==  ^  == )",
    "   )  \\_p/   (",
    "  (           )",
    " ( (  )   (  ) )",
    "(__(__)___(__)__)",
  ];

  var lookLeft = [
    "    /\\_____/\\",
    "   / o   o   \\",
    "  ( ==  ^  == )",
    "   )         (",
    "  (           )",
    " ( (  )   (  ) )",
    "(__(__)___(__)__)",
  ];

  var lookRight = [
    "    /\\_____/\\",
    "   /   o   o \\",
    "  ( ==  ^  == )",
    "   )         (",
    "  (           )",
    " ( (  )   (  ) )",
    "(__(__)___(__)__)",
  ];

  var tailR = [
    "    /\\_____/\\",
    "   /  o   o  \\",
    "  ( ==  ^  == )",
    "   )         (",
    "  (           )  ~",
    " ( (  )   (  ) )/",
    "(__(__)___(__)__)",
  ];

  var tailL = [
    "    /\\_____/\\",
    "   /  o   o  \\",
    "  ( ==  ^  == )",
    "   )         (",
    "~  (           )",
    " \\( (  )   (  ) )",
    "(__(__)___(__)__)",
  ];

  var paw = [
    "    /\\_____/\\",
    "   /  o   o  \\",
    "  ( ==  ^  == )",
    "   )         (",
    "  (     /)    )",
    " ( (  ) ' (  ) )",
    "(__(__)___(__)__)",
  ];

  var seq = [
    sit, sit, sit, sit, blink, sit,
    sit, sit, lookLeft, lookLeft, sit, sit,
    lookRight, lookRight, sit, sit, blink, sit,
    tailR, tailR, sit, tailL, tailL, sit,
    sit, sit, lick, lick, lick, sit,
    sit, sit, sit, blink, sit, sit,
    sit, paw, paw, sit, sit, sit,
    sit, sit, lookLeft, blink, sit, sit,
  ];

  var i = 0;
  function tick() {
    el.textContent = seq[i].join('\n');
    i = (i + 1) % seq.length;
  }
  tick();
  setInterval(tick, 400);
})();
