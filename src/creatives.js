'use strict';

/* Where the empty code plate sits on each graphic that ships with the app,
   in the image's own pixels. The partner's browser paints their code into
   this rectangle before the download starts, so every partner hands out a
   graphic with their own code on it and nobody has to make a new file. */

const PLATES = {
  '01-post-driveway.png':      { w: 1080, h: 1080, plate: { x: 547, y: 934,  w: 330, h: 54 } },
  '02-post-packages.png':      { w: 1080, h: 1080, plate: { x: 557, y: 934,  w: 330, h: 54 } },
  '03-post-addons.png':        { w: 1080, h: 1080, plate: { x: 547, y: 934,  w: 330, h: 54 } },
  '04-post-customers.png':     { w: 1080, h: 1080, plate: { x: 547, y: 934,  w: 330, h: 54 } },
  '05-story-headlight.png':    { w: 1080, h: 1920, plate: { x: 547, y: 1769, w: 330, h: 54 } },
  '06-story-how-it-works.png': { w: 1080, h: 1920, plate: { x: 547, y: 1769, w: 330, h: 54 } },
};

function plateFor(filename) {
  return Object.prototype.hasOwnProperty.call(PLATES, filename) ? PLATES[filename] : null;
}

module.exports = { PLATES, plateFor };
