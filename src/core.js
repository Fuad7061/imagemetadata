
/**
 * Cloudflare Worker: /embed-metadata  (also aliased to /strip-metadata)
 * Anti-AI-Detection Metadata Enhancement
 */

const CAMERA_PROFILES = [
    {
        id: "sony-a7iv-85",
        make: "SONY",
        model: "ILCE-7M4",
        software: "Adobe Photoshop Lightroom Classic 13.4 (Macintosh)",
        lensMake: "SONY",
        lensModel: "FE 85mm F1.8",
        focalLength: 85,
        focalLength35mm: 85,
        minAperture: 1.8,
        maxAperture: 16,
        minISO: 100,
        maxISO: 3200,
        makerNotePrefix: [0x53, 0x4F, 0x4E, 0x59, 0x20, 0x44, 0x53, 0x43, 0x20, 0x00] // "SONY DSC \0"
    },
    {
        id: "nikon-z8-35",
        make: "NIKON CORPORATION",
        model: "NIKON Z 8",
        software: "Adobe Photoshop 25.12 (Windows)",
        lensMake: "NIKON",
        lensModel: "NIKKOR Z 35mm f/1.8 S",
        focalLength: 35,
        focalLength35mm: 35,
        minAperture: 1.8,
        maxAperture: 16,
        minISO: 64,
        maxISO: 3200,
        makerNotePrefix: [0x4E, 0x69, 0x6B, 0x6F, 0x6E, 0x00, 0x02, 0x10] // "Nikon\0\x02\x10"
    },
    {
        id: "canon-r5-50",
        make: "Canon",
        model: "Canon EOS R5",
        software: "Adobe Photoshop Lightroom Classic 13.4 (Windows)",
        lensMake: "Canon",
        lensModel: "RF50mm F1.8 STM",
        focalLength: 50,
        focalLength35mm: 50,
        minAperture: 1.8,
        maxAperture: 22,
        minISO: 100,
        maxISO: 3200,
        makerNotePrefix: [0x28, 0x00, 0x01, 0x00]
    },
    {
        id: "fuji-xt5-23",
        make: "FUJIFILM",
        model: "X-T5",
        software: "Adobe Photoshop Lightroom Classic 13.4 (Macintosh)",
        lensMake: "FUJIFILM",
        lensModel: "XF23mmF2 R WR",
        focalLength: 23,
        focalLength35mm: 35,
        minAperture: 2.0,
        maxAperture: 16,
        minISO: 125,
        maxISO: 3200,
        makerNotePrefix: [0x46, 0x55, 0x4A, 0x49, 0x46, 0x49, 0x4C, 0x4D, 0x0C, 0x00] // "FUJIFILM"
    }
];

const WORLD_CITIES = [
    { city: "Paris", country: "France", lat: 48.8566, lon: 2.3522 },
    { city: "London", country: "UK", lat: 51.5074, lon: -0.1278 },
    { city: "New York", country: "USA", lat: 40.7128, lon: -74.0060 },
    { city: "Tokyo", country: "Japan", lat: 35.6895, lon: 139.6917 },
    { city: "Dubai", country: "UAE", lat: 25.2048, lon: 55.2708 },
    { city: "Barcelona", country: "Spain", lat: 41.3851, lon: 2.1734 },
    { city: "Amsterdam", country: "Netherlands", lat: 52.3676, lon: 4.9041 },
    { city: "Singapore", country: "Singapore", lat: 1.3521, lon: 103.8198 },
    { city: "Sydney", country: "Australia", lat: -33.8688, lon: 151.2093 },
    { city: "Rome", country: "Italy", lat: 41.9028, lon: 12.4964 },
    { city: "Bangkok", country: "Thailand", lat: 13.7563, lon: 100.5018 },
    { city: "Istanbul", country: "Turkey", lat: 41.0082, lon: 28.9784 },
    { city: "Vienna", country: "Austria", lat: 48.2082, lon: 16.3738 },
    { city: "Prague", country: "Czech Republic", lat: 50.0755, lon: 14.4378 },
    { city: "Seoul", country: "South Korea", lat: 37.5665, lon: 126.9780 },
    { city: "Lisbon", country: "Portugal", lat: 38.7169, lon: -9.1399 },
    { city: "Copenhagen", country: "Denmark", lat: 55.6761, lon: 12.5683 },
    { city: "Zurich", country: "Switzerland", lat: 47.3769, lon: 8.5417 },
    { city: "Montreal", country: "Canada", lat: 45.5017, lon: -73.5673 },
    { city: "Melbourne", country: "Australia", lat: -37.8136, lon: 144.9631 }
];

export default {
    async fetch(request, options = {}) {
        const { pathname } = new URL(request.url);

        if (pathname === "/docs") {
            return generateDocs(options);
        }

        if (pathname !== "/embed-metadata" && pathname !== "/strip-metadata") {
            return jsonResp({ error: "Not found. POST to /embed-metadata or GET /docs" }, 404);
        }
        if (request.method !== "POST") {
            return jsonResp({ error: "Method not allowed. Use POST." }, 405);
        }

        let body;
        try {
            body = await request.json();
        } catch {
            return jsonResp({ error: "Invalid JSON body." }, 400);
        }

        const {
            image_path = "",
            title = "",
            description = "",
            keywords = [],
            category = "",
            creator = "",
            copyright = "",
            camera_profile,
            location,
            software
        } = body;

        let isBase64 = false;
        let base64Data = "";

        const isStrip = pathname === "/strip-metadata";
        const errs = [];
        if (!image_path || typeof image_path !== "string") {
            errs.push("image_path must be a valid HTTP/HTTPS URL or Base64 string.");
        } else if (/^https?:\/\/.+/i.test(image_path)) {
            // Valid URL
        } else if (image_path.startsWith("data:image/")) {
            isBase64 = true;
            base64Data = image_path.split(",")[1];
        } else if (/^[A-Za-z0-9+/=]+$/.test(image_path) && image_path.length > 100) {
            isBase64 = true;
            base64Data = image_path;
        } else {
            errs.push("image_path must be a valid HTTP/HTTPS URL or Base64 image string.");
        }

        if (!isStrip) {
            if (!title || !title.trim())
                errs.push("title is required.");
            else if (title.length > 200)
                errs.push("title must be under 200 characters.");
            if (!Array.isArray(keywords))
                errs.push("keywords must be an array.");
            else if (keywords.length > 50)
                errs.push("Maximum 50 keywords allowed.");
            if (description && description.length > 2000)
                errs.push("description must be under 2000 characters.");
        }

        if (errs.length) return jsonResp({ error: "Validation failed", details: errs }, 422);

        const cleanKw = cleanKeywords(keywords);

        let srcBytes;
        if (isBase64) {
            try {
                const binaryString = atob(base64Data);
                srcBytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    srcBytes[i] = binaryString.charCodeAt(i);
                }
            } catch (e) {
                return jsonResp({ error: "Failed to decode base64 image data." }, 400);
            }
        } else {
            let imgResp;
            try {
                let fetchUrl = image_path;
                imgResp = await fetch(fetchUrl, {
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                    },
                    redirect: "follow",
                });
                if (!imgResp.ok && imgResp.status >= 300 && imgResp.status < 400) {
                    const location = imgResp.headers.get("location");
                    if (location) {
                        fetchUrl = new URL(location, fetchUrl).href;
                        imgResp = await fetch(fetchUrl, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" }, redirect: "follow" });
                    }
                }
            } catch (e) {
                return jsonResp({ error: `Could not fetch image: ${e.message}` }, 502);
            }
            if (!imgResp.ok)
                return jsonResp({ error: `Image URL returned HTTP ${imgResp.status}` }, 502);
            const srcBuffer = await imgResp.arrayBuffer();
            srcBytes = new Uint8Array(srcBuffer);
        }

        const detectedFormat = detectImageFormat(srcBytes);
        if (!detectedFormat) {
            return jsonResp({
                error: "Unsupported or unrecognised image format.",
                hint: "Supported formats: JPEG, PNG, WebP, GIF, BMP, TIFF.",
            }, 415);
        }



        let outputBytes;
        let finalTitle = title || "";
        let ctx = null;
        let outputFormat = "JPEG";

        let processedBytes = srcBytes;
        if (detectedFormat !== "JPEG") {
            try {
                processedBytes = await convertToJpeg(srcBytes, detectedFormat, image_path, options);
            } catch (e) {
                return jsonResp({
                    error: `Failed to convert ${detectedFormat} to JPEG: ${e.message}`,
                    hint: "Try supplying a JPEG directly, or ensure the URL is accessible for conversion.",
                }, 500);
            }
        }

        if (isStrip) {
            outputBytes = stripJpegMetadata(processedBytes);
            if (!finalTitle) finalTitle = "stripped-image";
        } else {
            ctx = resolveShootContext(camera_profile, location, software);
            try {
                const dims = parseImageDimensions(processedBytes) || { w: 1024, h: 1024 };
                outputBytes = embedJpegMetadata(processedBytes, { title, description, keywords: cleanKw, category, creator, copyright }, ctx, dims);
            } catch (e) {
                return jsonResp({ error: `Metadata embedding failed: ${e.message}`, stack: e.stack }, 500);
            }
        }

        let sanitizedTitle = finalTitle.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '');
        if (!sanitizedTitle) sanitizedTitle = "image";
        const outFilename = sanitizedTitle + ".jpg";

        let uploadResult;
        try {
            uploadResult = await uploadWithFallback(outputBytes, outFilename, options);
        } catch (e) {
            return jsonResp({ error: `Upload failed (all providers): ${e.message}` }, 502);
        }

        if (isStrip) {
            return jsonResp({
                success: true,
                stripped_image_url: uploadResult.url,
                expires_at: uploadResult.expires_at,
                upload_provider: uploadResult.provider,
                original_url: image_path,
                file_size_bytes: outputBytes.length,
                format: detectedFormat,
                output_format: outputFormat
            });
        }

        return jsonResp({
            success: true,
            metadata_image_url: uploadResult.url,
            expires_at: uploadResult.expires_at,
            upload_provider: uploadResult.provider,
            original_url: image_path,
            file_size_bytes: outputBytes.length,
            format: detectedFormat,
            output_format: outputFormat,
            metadata: { title, description, keywords: cleanKw, category, creator, copyright },
            exif_context: {
                camera: ctx.profile.model,
                shoot_date: ctx.shootDate,
                city: ctx.city,
                shutter_speed: `1/${Math.round(1 / ctx.exposureTime)}`,
                aperture: `f/${ctx.fNumber}`,
                iso: ctx.iso
            }
        });
    },
};

// ---------------------------------------------------------------------
// Core Logic & Generators
// ---------------------------------------------------------------------

function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomPick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function randomGaussJitter(scale) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    let num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return num * scale;
}

function generateRandomDateWithin30Days() {
    const now = new Date();
    const daysAgo = randomInt(0, 30);
    const targetDate = new Date(now.getTime() - (daysAgo * 24 * 60 * 60 * 1000));

    // Golden hour bias (07:00-09:00 or 16:00-19:00)
    let hour;
    const r = Math.random();
    if (r < 0.3) hour = randomInt(7, 9);
    else if (r < 0.6) hour = randomInt(16, 19);
    else hour = randomInt(10, 15);

    targetDate.setHours(hour, randomInt(0, 59), randomInt(0, 59));
    return targetDate;
}

function resolveShootContext(profileId, locationInput, softwareOverride) {
    let profile = CAMERA_PROFILES.find(p => p.id === profileId);
    if (!profile) profile = randomPick(CAMERA_PROFILES);

    const shootDate = generateRandomDateWithin30Days();

    let cityObj;
    if (locationInput && locationInput.lat && locationInput.lon) {
        cityObj = {
            lat: locationInput.lat,
            lon: locationInput.lon,
            city: locationInput.city || "Unknown",
            country: locationInput.country || "Unknown"
        };
    } else {
        cityObj = randomPick(WORLD_CITIES);
    }

    const lat = cityObj.lat + randomGaussJitter(0.005);
    const lon = cityObj.lon + randomGaussJitter(0.005);

    // Exposure logic
    const fNumber = Math.round((Math.random() * (8.0 - profile.minAperture) + profile.minAperture) * 10) / 10;
    const isoList = [100, 200, 400, 800];
    const iso = randomPick(isoList.filter(i => i >= profile.minISO && i <= profile.maxISO)) || 100;

    // Sunny 16 rule roughly: Shutter speed = 1/(ISO) at f/16 in sun.
    // For f/fNumber, Ev = log2(fNumber^2) - log2(1/shutter) = log2(ISO/100) + Bv
    // Shutter = (fNumber^2 * 100) / (ISO * 2^Bv)
    const Bv = randomInt(5, 10); // Brightness value (outdoors daytime)
    let exposureTime = (fNumber * fNumber * 100) / (iso * Math.pow(2, Bv));
    // Round to standard shutter speeds (approx)
    if (exposureTime < 1 / 4000) exposureTime = 1 / 4000;
    else if (exposureTime > 1 / 10) exposureTime = 1 / 10;

    const shutterSpeedValue = -Math.log2(exposureTime);
    const apertureValue = Math.log2(fNumber * fNumber);

    return {
        profile,
        software: softwareOverride || profile.software,
        shootDate,
        shootDateStr: `${shootDate.getFullYear()}:${String(shootDate.getMonth() + 1).padStart(2, '0')}:${String(shootDate.getDate()).padStart(2, '0')} ${String(shootDate.getHours()).padStart(2, '0')}:${String(shootDate.getMinutes()).padStart(2, '0')}:${String(shootDate.getSeconds()).padStart(2, '0')}`,
        shootDateIso: shootDate.toISOString().split('.')[0] + 'Z',
        lat,
        lon,
        city: cityObj.city,
        country: cityObj.country,
        exposureTime,
        fNumber,
        iso,
        shutterSpeedValue,
        apertureValue,
        docId: uuid(),
        origDocId: uuid(),
        instId: uuid()
    };
}

// ---------------------------------------------------------------------
// TIFF / EXIF Builder
// ---------------------------------------------------------------------

function encAscii(str) {
    const buf = new Uint8Array(str.length + 1);
    for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i);
    buf[str.length] = 0; // null terminator
    return buf;
}

function encRational(num, den) {
    const buf = new Uint8Array(8);
    const view = new DataView(buf.buffer);
    view.setUint32(0, num, true);
    view.setUint32(4, den, true);
    return buf;
}

function encSRational(num, den) {
    const buf = new Uint8Array(8);
    const view = new DataView(buf.buffer);
    view.setInt32(0, num, true);
    view.setInt32(4, den, true);
    return buf;
}

function buildTiffIfd(entries, startOffset) {
    const entryCount = entries.length;
    const ifdLen = 2 + entryCount * 12 + 4;
    let heapLen = 0;
    for (const e of entries) {
        if (e.value.length > 4) {
            heapLen += e.value.length;
            if (heapLen % 2 !== 0) heapLen++; // pad
        }
    }
    const buf = new Uint8Array(ifdLen + heapLen);
    const view = new DataView(buf.buffer);

    view.setUint16(0, entryCount, true);
    let offset = 2;
    let heapOffset = startOffset + ifdLen;
    let currentHeap = ifdLen;

    for (const e of entries) {
        view.setUint16(offset, e.tag, true);
        view.setUint16(offset + 2, e.type, true);
        const count = e.type === 2 ? e.value.length : (e.value.length / (e.type === 5 || e.type === 10 ? 8 : (e.type === 3 ? 2 : 1)));
        view.setUint32(offset + 4, count, true);

        if (e.value.length <= 4) {
            buf.set(e.value, offset + 8);
        } else {
            view.setUint32(offset + 8, heapOffset, true);
            buf.set(e.value, currentHeap);
            currentHeap += e.value.length;
            if (currentHeap % 2 !== 0) currentHeap++;
            heapOffset += e.value.length;
            if (heapOffset % 2 !== 0) heapOffset++;
        }
        offset += 12;
    }
    view.setUint32(offset, 0, true);
    return { buf, size: ifdLen + heapLen };
}

function u32Array(val) {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, val, true);
    return buf;
}
function u16Array(val) {
    const buf = new Uint8Array(2);
    new DataView(buf.buffer).setUint16(0, val, true);
    return buf;
}

function floatToRational(f) {
    const den = 1000000;
    return encRational(Math.round(f * den), den);
}

function floatToSRational(f) {
    const den = 1000000;
    return encSRational(Math.round(f * den), den);
}

function degToGpsRationals(deg) {
    const d = Math.floor(deg);
    const minFloat = (deg - d) * 60;
    const m = Math.floor(minFloat);
    const s = (minFloat - m) * 60;
    const buf = new Uint8Array(24);
    buf.set(encRational(d, 1), 0);
    buf.set(encRational(m, 1), 8);
    buf.set(encRational(Math.round(s * 100), 100), 16);
    return buf;
}

function buildExifBlock(ctx, meta, dims) {
    // tags: 
    // IFD0: 
    // 0x010E ImageDescription
    // 0x010F Make
    // 0x0110 Model
    // 0x0112 Orientation (1)
    // 0x011A XResolution (72/1)
    // 0x011B YResolution (72/1)
    // 0x0128 ResolutionUnit (2)
    // 0x0131 Software
    // 0x0132 DateTime
    // 0x013B Artist
    // 0x0213 YCbCrPositioning (1)
    // 0x8298 Copyright
    // 0x8769 ExifOffset
    // 0x8825 GPSInfoOffset

    const ifd0Entries = [];
    if (meta.description) ifd0Entries.push({ tag: 0x010E, type: 2, value: encAscii(meta.description.slice(0, 100)) });
    ifd0Entries.push({ tag: 0x010F, type: 2, value: encAscii(ctx.profile.make) });
    ifd0Entries.push({ tag: 0x0110, type: 2, value: encAscii(ctx.profile.model) });
    ifd0Entries.push({ tag: 0x0112, type: 3, value: u16Array(1) });
    ifd0Entries.push({ tag: 0x011A, type: 5, value: encRational(72, 1) });
    ifd0Entries.push({ tag: 0x011B, type: 5, value: encRational(72, 1) });
    ifd0Entries.push({ tag: 0x0128, type: 3, value: u16Array(2) });
    ifd0Entries.push({ tag: 0x0131, type: 2, value: encAscii(ctx.software) });
    ifd0Entries.push({ tag: 0x0132, type: 2, value: encAscii(ctx.shootDateStr) });
    if (meta.creator) ifd0Entries.push({ tag: 0x013B, type: 2, value: encAscii(meta.creator) });
    ifd0Entries.push({ tag: 0x0213, type: 3, value: u16Array(1) });
    if (meta.copyright) ifd0Entries.push({ tag: 0x8298, type: 2, value: encAscii(meta.copyright) });

    // We'll calculate offsets later
    const exifOffsetEntry = { tag: 0x8769, type: 4, value: u32Array(0) };
    const gpsOffsetEntry = { tag: 0x8825, type: 4, value: u32Array(0) };
    ifd0Entries.push(exifOffsetEntry);
    ifd0Entries.push(gpsOffsetEntry);

    // SubIFD (ExifIFD)
    const exifEntries = [];
    exifEntries.push({ tag: 0x829A, type: 5, value: floatToRational(ctx.exposureTime) });
    exifEntries.push({ tag: 0x829D, type: 5, value: floatToRational(ctx.fNumber) });
    exifEntries.push({ tag: 0x8827, type: 3, value: u16Array(ctx.iso) });
    exifEntries.push({ tag: 0x9000, type: 7, value: u8([0x30, 0x32, 0x33, 0x31]) }); // "0231"
    exifEntries.push({ tag: 0x9003, type: 2, value: encAscii(ctx.shootDateStr) });
    exifEntries.push({ tag: 0x9004, type: 2, value: encAscii(ctx.shootDateStr) });
    exifEntries.push({ tag: 0x9201, type: 10, value: floatToSRational(ctx.shutterSpeedValue) });
    exifEntries.push({ tag: 0x9202, type: 5, value: floatToRational(ctx.apertureValue) });
    exifEntries.push({ tag: 0x9204, type: 10, value: floatToSRational(0) }); // ExpBias
    exifEntries.push({ tag: 0x9205, type: 5, value: floatToRational(ctx.profile.minAperture) });
    exifEntries.push({ tag: 0x9207, type: 3, value: u16Array(5) }); // Pattern metering
    exifEntries.push({ tag: 0x9209, type: 3, value: u16Array(16) }); // Flash off
    exifEntries.push({ tag: 0x920A, type: 5, value: floatToRational(ctx.profile.focalLength) });
    // MakerNote
    exifEntries.push({ tag: 0x927C, type: 7, value: u8(ctx.profile.makerNotePrefix) });
    exifEntries.push({ tag: 0xA000, type: 7, value: u8([0x30, 0x31, 0x30, 0x30]) }); // "0100"
    exifEntries.push({ tag: 0xA001, type: 3, value: u16Array(1) }); // sRGB
    exifEntries.push({ tag: 0xA002, type: 4, value: u32Array(dims.w) });
    exifEntries.push({ tag: 0xA003, type: 4, value: u32Array(dims.h) });
    exifEntries.push({ tag: 0xA405, type: 3, value: u16Array(ctx.profile.focalLength35mm) });
    exifEntries.push({ tag: 0xA406, type: 3, value: u16Array(0) }); // Scene standard
    exifEntries.push({ tag: 0xA433, type: 2, value: encAscii(ctx.profile.lensMake) });
    exifEntries.push({ tag: 0xA434, type: 2, value: encAscii(ctx.profile.lensModel) });

    // GPS IFD
    const gpsEntries = [];
    gpsEntries.push({ tag: 0x0000, type: 1, value: u8([2, 3, 0, 0]) });
    gpsEntries.push({ tag: 0x0001, type: 2, value: encAscii(ctx.lat >= 0 ? "N" : "S") });
    gpsEntries.push({ tag: 0x0002, type: 5, value: degToGpsRationals(Math.abs(ctx.lat)) });
    gpsEntries.push({ tag: 0x0003, type: 2, value: encAscii(ctx.lon >= 0 ? "E" : "W") });
    gpsEntries.push({ tag: 0x0004, type: 5, value: degToGpsRationals(Math.abs(ctx.lon)) });
    gpsEntries.push({ tag: 0x0005, type: 1, value: u8([0]) }); // alt ref above sea
    gpsEntries.push({ tag: 0x0006, type: 5, value: floatToRational(10.5) }); // 10m alt
    gpsEntries.push({ tag: 0x000B, type: 5, value: floatToRational(1.2) }); // DOP

    // Build the tables
    // offset 8 is where IFD0 starts
    const tiffHeader = u8([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00]);

    let currentOffset = 8;
    const ifd0 = buildTiffIfd(ifd0Entries, currentOffset);
    currentOffset += ifd0.size;

    // Set ExifOffset
    new DataView(ifd0.buf.buffer).setUint32(2 + ifd0Entries.indexOf(exifOffsetEntry) * 12 + 8, currentOffset, true);
    const exifIfd = buildTiffIfd(exifEntries, currentOffset);
    currentOffset += exifIfd.size;

    // Set GPSOffset
    new DataView(ifd0.buf.buffer).setUint32(2 + ifd0Entries.indexOf(gpsOffsetEntry) * 12 + 8, currentOffset, true);
    const gpsIfd = buildTiffIfd(gpsEntries, currentOffset);
    currentOffset += gpsIfd.size;

    // IFD1 (Thumbnail stub)
    // We'll set IFD0's next IFD pointer to IFD1
    const ifd1Entries = [
        { tag: 0x0103, type: 3, value: u16Array(6) }, // Compression JPEG
        { tag: 0x011A, type: 5, value: encRational(72, 1) },
        { tag: 0x011B, type: 5, value: encRational(72, 1) },
        { tag: 0x0128, type: 3, value: u16Array(2) },
        { tag: 0x0201, type: 4, value: u32Array(currentOffset + 2 + 6 * 12 + 4) }, // JPEGInterchangeFormat
        { tag: 0x0202, type: 4, value: u32Array(0) } // JPEGInterchangeFormatLength
    ];
    new DataView(ifd0.buf.buffer).setUint32(2 + ifd0Entries.length * 12, currentOffset, true);
    const ifd1 = buildTiffIfd(ifd1Entries, currentOffset);

    return concat([tiffHeader, ifd0.buf, exifIfd.buf, gpsIfd.buf, ifd1.buf]);
}

function makeApp1Exif(exifBytes) {
    const magic = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // "Exif\0\0"
    const payloadLen = magic.length + exifBytes.length;
    const segLen = 2 + payloadLen;
    const buf = new Uint8Array(2 + 2 + payloadLen);
    buf[0] = 0xFF; buf[1] = 0xE1;
    buf[2] = (segLen >> 8) & 0xFF;
    buf[3] = segLen & 0xFF;
    buf.set(magic, 4);
    buf.set(exifBytes, 4 + magic.length);
    return buf;
}

// ---------------------------------------------------------------------
// XMP / IPTC
// ---------------------------------------------------------------------

function buildXmp(m, ctx) {
    const kwBag = m.keywords.map(k => `        <rdf:li>${esc(k)}</rdf:li>`).join("\n");
    return (
        `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:dc="http://purl.org/dc/elements/1.1/"
   xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
   xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/"
   xmlns:tiff="http://ns.adobe.com/tiff/1.0/"
   xmlns:exif="http://ns.adobe.com/exif/1.0/"
   xmlns:aux="http://ns.adobe.com/exif/1.0/aux/"
   xmlns:xmp="http://ns.adobe.com/xap/1.0/"
   xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
   xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(m.title)}</rdf:li></rdf:Alt></dc:title>
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${esc(m.description)}</rdf:li></rdf:Alt></dc:description>
   <dc:subject><rdf:Bag>${kwBag}</rdf:Bag></dc:subject>
   <dc:creator><rdf:Seq><rdf:li>${esc(m.creator)}</rdf:li></rdf:Seq></dc:creator>
   <dc:rights><rdf:Alt><rdf:li xml:lang="x-default">${esc(m.copyright)}</rdf:li></rdf:Alt></dc:rights>
   <photoshop:Headline>${esc(m.title)}</photoshop:Headline>
   <photoshop:Category>${esc(m.category.slice(0, 3))}</photoshop:Category>
   <xmpRights:WebStatement>${esc(m.copyright)}</xmpRights:WebStatement>
   
   <tiff:Make>${esc(ctx.profile.make)}</tiff:Make>
   <tiff:Model>${esc(ctx.profile.model)}</tiff:Model>
   <tiff:Software>${esc(ctx.software)}</tiff:Software>
   
   <exif:ExposureTime>${Math.round(ctx.exposureTime * 1000000)}/1000000</exif:ExposureTime>
   <exif:FNumber>${ctx.fNumber}</exif:FNumber>
   <exif:ISO>${ctx.iso}</exif:ISO>
   <exif:FocalLength>${ctx.profile.focalLength}/1</exif:FocalLength>
   
   <aux:LensMake>${esc(ctx.profile.lensMake)}</aux:LensMake>
   <aux:Lens>${esc(ctx.profile.lensModel)}</aux:Lens>
   
   <xmp:CreateDate>${ctx.shootDateIso}</xmp:CreateDate>
   <xmp:ModifyDate>${ctx.shootDateIso}</xmp:ModifyDate>
   <xmp:MetadataDate>${ctx.shootDateIso}</xmp:MetadataDate>
   <xmp:CreatorTool>${esc(ctx.software)}</xmp:CreatorTool>
   
   <xmpMM:DocumentID>xmp.did:${ctx.docId}</xmpMM:DocumentID>
   <xmpMM:OriginalDocumentID>xmp.did:${ctx.origDocId}</xmpMM:OriginalDocumentID>
   <xmpMM:InstanceID>xmp.iid:${ctx.instId}</xmpMM:InstanceID>
   
   <crs:CameraProfile>Camera Standard</crs:CameraProfile>
   <crs:HasSettings>False</crs:HasSettings>
   
   <Iptc4xmpCore:Location>${esc(ctx.city)}</Iptc4xmpCore:Location>
   <Iptc4xmpCore:CountryCode>${esc(ctx.country.slice(0, 2).toUpperCase())}</Iptc4xmpCore:CountryCode>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
    );
}

function makeApp1Xmp(xmpStr) {
    const enc = new TextEncoder();
    const ns = enc.encode("http://ns.adobe.com/xap/1.0/\0");
    const data = enc.encode(xmpStr);
    const segLen = 2 + ns.length + data.length;
    const buf = new Uint8Array(2 + 2 + ns.length + data.length);
    let i = 0;
    buf[i++] = 0xff; buf[i++] = 0xe1;
    buf[i++] = (segLen >> 8) & 0xff;
    buf[i++] = segLen & 0xff;
    buf.set(ns, i); i += ns.length;
    buf.set(data, i);
    return buf;
}

function buildIptc(m, ctx) {
    const enc = new TextEncoder();
    const parts = [];

    function ds(tag, value) {
        const val = typeof value === "string" ? enc.encode(value) : value;
        const b = new Uint8Array(5 + val.length);
        b[0] = 0x1c; b[1] = 0x02; b[2] = tag;
        b[3] = (val.length >> 8) & 0xff;
        b[4] = val.length & 0xff;
        b.set(val, 5);
        parts.push(b);
    }

    ds(0x00, u8([0x00, 0x04]));
    if (m.title) ds(0x05, m.title.slice(0, 64));
    if (m.category) ds(0x0f, m.category.slice(0, 3));
    m.keywords.forEach(k => ds(0x19, k.slice(0, 64)));
    if (m.description) ds(0x78, m.description.slice(0, 2000));
    if (m.creator) ds(0x50, m.creator.slice(0, 32));
    if (m.copyright) ds(0x74, m.copyright.slice(0, 128));
    if (ctx.city) ds(0x5A, ctx.city.slice(0, 32));
    if (ctx.country) ds(0x65, ctx.country.slice(0, 64));

    ds(0x37,
        String(ctx.shootDate.getFullYear()) +
        String(ctx.shootDate.getMonth() + 1).padStart(2, "0") +
        String(ctx.shootDate.getDate()).padStart(2, "0")
    );

    return concat(parts);
}

function makeApp13(iptcBytes) {
    const enc = new TextEncoder();
    const sig = enc.encode("Photoshop 3.0\0");
    const bim = enc.encode("8BIM");
    const resType = u8([0x04, 0x04]);
    const resName = u8([0x00, 0x00]);

    const dLen = iptcBytes.length;
    const dLenBuf = u8([(dLen >> 24) & 0xff, (dLen >> 16) & 0xff, (dLen >> 8) & 0xff, dLen & 0xff]);
    const padded = dLen % 2 === 0 ? iptcBytes : concat([iptcBytes, u8([0x00])]);

    const payload = concat([sig, bim, resType, resName, dLenBuf, padded]);
    const segLen = 2 + payload.length;

    const buf = new Uint8Array(2 + 2 + payload.length);
    let i = 0;
    buf[i++] = 0xff; buf[i++] = 0xed;
    buf[i++] = (segLen >> 8) & 0xff;
    buf[i++] = segLen & 0xff;
    buf.set(payload, i);
    return buf;
}

function makeComSegment() {
    const msg = new TextEncoder().encode("sRGB IEC61966-2.1");
    const segLen = 2 + msg.length;
    const buf = new Uint8Array(2 + 2 + msg.length);
    buf[0] = 0xff; buf[1] = 0xfe;
    buf[2] = (segLen >> 8) & 0xff;
    buf[3] = segLen & 0xff;
    buf.set(msg, 4);
    return buf;
}

function parseImageDimensions(src) {
    let pos = 2;
    while (pos < src.length) {
        while (pos < src.length && src[pos] !== 0xff) pos++;
        if (pos >= src.length) break;
        while (pos < src.length && src[pos] === 0xff) pos++;
        if (pos >= src.length) break;

        const b = src[pos++];
        if (b === 0xc0 || b === 0xc2) { // SOF0 or SOF2
            pos += 3; // skip len, precision
            const h = (src[pos] << 8) | src[pos + 1];
            const w = (src[pos + 2] << 8) | src[pos + 3];
            return { w, h };
        }

        const len = (src[pos] << 8) | src[pos + 1];
        pos += len;
    }
    return null;
}

function stripJpegMetadata(src) {
    const segments = parseJpeg(src);
    const out = [u8([0xff, 0xd8])];

    for (const seg of segments) {
        // Strip all APP segments (0xFFE0 to 0xFFEF) and COM segment (0xFFFE)
        if (seg.marker >= 0xffe0 && seg.marker <= 0xffef) continue;
        if (seg.marker === 0xfffe) continue;

        out.push(seg.full);
    }

    return concat(out);
}

function embedJpegMetadata(src, meta, ctx, dims) {
    const segments = parseJpeg(src);

    const app1Exif = makeApp1Exif(buildExifBlock(ctx, meta, dims));
    const app1Xmp = makeApp1Xmp(buildXmp(meta, ctx));
    const app13 = makeApp13(buildIptc(meta, ctx));
    const comSeg = makeComSegment();

    const out = [u8([0xff, 0xd8])];
    out.push(app1Exif, app1Xmp, app13, comSeg);

    for (const seg of segments) {
        // Strip APP0 (JFIF)
        if (seg.marker === 0xffe0) continue;
        // Strip existing APP1 (EXIF or XMP)
        if (seg.marker === 0xffe1) continue;
        // Strip existing APP13
        if (seg.marker === 0xffed) continue;
        // Strip existing COM
        if (seg.marker === 0xfffe) continue;

        out.push(seg.full);
    }

    return concat(out);
}

function parseJpeg(src) {
    const segs = [];
    let pos = 2; // skip SOI bytes

    while (pos < src.length) {
        while (pos < src.length && src[pos] !== 0xff) pos++;
        if (pos >= src.length) break;

        while (pos < src.length && src[pos] === 0xff) pos++;
        if (pos >= src.length) break;

        const b = src[pos++];
        const marker = 0xff00 | b;

        if (b === 0xd8 || b === 0xd9 || (b >= 0xd0 && b <= 0xd7)) {
            segs.push({ marker, payload: u8([]), full: u8([0xff, b]) });
            if (b === 0xd9) break;
            continue;
        }

        if (b === 0xda) {
            const full = src.slice(pos - 2);
            segs.push({ marker, payload: u8([]), full });
            break;
        }

        if (pos + 1 >= src.length) break;
        const segLen = (src[pos] << 8) | src[pos + 1];
        if (segLen < 2) { pos += 2; continue; }

        const dataStart = pos + 2;
        const dataLen = segLen - 2;
        const segEnd = pos + segLen;

        if (segEnd > src.length) {
            segs.push({
                marker,
                payload: src.slice(dataStart),
                full: src.slice(pos - 2),
            });
            break;
        }

        segs.push({
            marker,
            payload: src.slice(dataStart, dataStart + dataLen),
            full: src.slice(pos - 2, segEnd),
        });

        pos = segEnd;
    }

    return segs;
}

// ---------------------------------------------------------------------
// Image format detection & Cloudflare Fallbacks
// ---------------------------------------------------------------------

function detectImageFormat(bytes) {
    if (bytes.length < 12) return null;
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "JPEG";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
        bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a &&
        bytes[6] === 0x1a && bytes[7] === 0x0a) return "PNG";
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
        bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 &&
        bytes[10] === 0x42 && bytes[11] === 0x50) return "WebP";
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
        bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) &&
        bytes[5] === 0x61) return "GIF";
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "BMP";
    if ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
        (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
        return "TIFF";
    return null;
}

async function convertToJpeg(srcBytes, srcFormat, originalUrl, options = {}) {
    if (!originalUrl.startsWith("http")) {
        throw new Error(
            `Base64 input must be a valid JPEG. Pure pixel transcoding from ${srcFormat} to JPEG requires a URL.`
        );
    }

    // Try using wsrv.nl for high-quality format conversion without quality loss
    try {
        let wsrvUrl = `https://wsrv.nl/?url=${encodeURIComponent(originalUrl)}&output=jpg&q=99`;
        let wsrvResp = await fetch(wsrvUrl, {
            headers: { "User-Agent": "MetadataWorker/2.0" },
            redirect: "follow",
        });

        // If wsrv.nl fails to fetch the original URL (e.g., due to bot protection or private IP),
        // upload our successfully fetched bytes to a public temp host and ask wsrv.nl to convert that URL.
        if (!wsrvResp.ok) {
            const tempFileName = `temp.${srcFormat.toLowerCase()}`;
            const tempUpload = await uploadWithFallback(srcBytes, tempFileName, options);
            wsrvUrl = `https://wsrv.nl/?url=${encodeURIComponent(tempUpload.url)}&output=jpg&q=99`;
            wsrvResp = await fetch(wsrvUrl, {
                headers: { "User-Agent": "MetadataWorker/2.0" },
                redirect: "follow",
            });
        }

        if (wsrvResp.ok) {
            const buf = await wsrvResp.arrayBuffer();
            const bytes = new Uint8Array(buf);
            if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return bytes;
        }
    } catch (e) {
        console.error("wsrv.nl fallback error:", e);
    }

    throw new Error(
        `Conversion from ${srcFormat} to JPEG failed even with wsrv.nl fallback. Please convert to JPEG before uploading.`
    );
}


// Upload helpers
// ---------------------------------------------------------------------

/** Derive MIME type from filename extension. */
function getMimeType(filename) {
    if (filename.endsWith(".png")) return "image/png";
    if (filename.endsWith(".webp")) return "image/webp";
    return "image/jpeg";
}

/**
 * Upload to tmpfiles.org with exponential backoff retry.
 * Retryable codes include 500 (Server Error), 502, 503, 504, 521.
 */
async function uploadToTmpfiles(bytes, filename) {
    const MAX_RETRIES = 2;
    const BASE_DELAY_MS = 800;        // backoff: 800 ms, 1600 ms
    const RETRYABLE = new Set([500, 502, 503, 504, 521]);
    const mime = getMimeType(filename);

    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, BASE_DELAY_MS * attempt));
        try {
            const form = new FormData();
            form.append("file", new Blob([bytes], { type: mime }), filename);
            const res = await fetch("https://tmpfiles.org/api/v1/upload", {
                method: "POST",
                body: form,
                signal: AbortSignal.timeout(20_000),
            });
            if (!res.ok) {
                const text = await res.text().catch(() => "");
                lastError = new Error(`tmpfiles HTTP ${res.status}: ${text.slice(0, 200)}`);
                if (!RETRYABLE.has(res.status)) throw lastError; // don't retry 4xx
                continue;
            }
            const json = await res.json();
            const pageUrl = json?.data?.url;
            if (!pageUrl) throw new Error("tmpfiles response missing data.url");

            const pageResp = await fetch(pageUrl, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                },
                redirect: "follow",
                signal: AbortSignal.timeout(15_000),
            });
            if (!pageResp.ok) throw new Error(`Failed to fetch tmpfiles page: HTTP ${pageResp.status}`);

            const html = await pageResp.text();
            const dlMatch = html.match(/https:\/\/tmpfiles\.org\/dl\/[^"]+/);
            if (!dlMatch) throw new Error("Could not extract download URL from tmpfiles page");

            const dlUrl = dlMatch[0];

            // Warm up the URL to make it stable for subsequent requests
            try {
                await fetch(dlUrl, {
                    method: "GET",
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                    },
                    signal: AbortSignal.timeout(15_000),
                });
            } catch {
                // Ignore warm-up errors; URL is still valid
            }

            return { url: dlUrl, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), provider: "tmpfiles" };
        } catch (e) {
            lastError = e;
        }
    }
    throw lastError;
}

/**
 * Upload to uguu.se (48-hour expiry, 100 MB limit).
 */
async function uploadToUguu(bytes, filename) {
    const form = new FormData();
    form.append("files[]", new Blob([bytes], { type: getMimeType(filename) }), filename);
    const res = await fetch("https://uguu.se/upload", {
        method: "POST",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MetadataWorker/2.0)" },
        body: form,
        signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`uguu HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const url = json?.files?.[0]?.url;
    if (!url) throw new Error(`uguu bad response: ${JSON.stringify(json).slice(0, 200)}`);
    return { url, expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), provider: "uguu" };
}

/**
 * Upload to litterbox.catbox.moe (24-hour expiry, 1 GB limit).
 */
async function uploadToLitterbox(bytes, filename) {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("time", "24h");
    form.append("fileToUpload", new Blob([bytes], { type: getMimeType(filename) }), filename);
    const res = await fetch("https://litterbox.catbox.moe/resources/internals/api.php", {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`litterbox HTTP ${res.status}`);
    const url = (await res.text()).trim();
    if (!url.startsWith("http")) throw new Error(`litterbox invalid response: ${url.slice(0, 100)}`);
    return { url, expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), provider: "litterbox" };
}

/**
 * Try upload providers in order: tmpfiles → uguu → litterbox.
 * Returns on the first success; throws a consolidated error if all fail.
 */
async function uploadWithFallback(bytes, filename, options = {}) {
    const allProviders = {
        tmpfiles: () => uploadToTmpfiles(bytes, filename),
        uguu: () => uploadToUguu(bytes, filename),
        litterbox: () => uploadToLitterbox(bytes, filename),
    };
    if (typeof options.localUpload === "function") {
        allProviders.local = () => options.localUpload(bytes, filename);
    }

    const requested = Array.isArray(options.uploadOrder) ? options.uploadOrder : [];
    const order = (requested.length ? requested : Object.keys(allProviders))
        .filter(name => typeof allProviders[name] === "function");

    const errors = [];
    for (const name of order) {
        try { return await allProviders[name](); } catch (e) { errors.push(`${name}: ${e.message}`); }
    }
    throw new Error(`All upload providers failed:\n${errors.map((m, i) => `  [${i + 1}] ${m}`).join("\n")}`);
}


// ---------------------------------------------------------------------
// Micro-utilities
// ---------------------------------------------------------------------

function concat(arrays) {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const result = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) { result.set(a, off); off += a.length; }
    return result;
}

function u8(arr) { return new Uint8Array(arr); }

function esc(s = "") {
    return String(s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function cleanKeywords(kws) {
    if (!Array.isArray(kws)) return [];
    const seen = new Set();
    return kws
        .filter(k => typeof k === "string" && k.trim())
        .filter(k => { const l = k.trim().toLowerCase(); if (seen.has(l)) return false; seen.add(l); return true; })
        .map(k => k.trim())
        .slice(0, 50);
}

function jsonResp(obj, status = 200) {
    return new Response(JSON.stringify(obj, null, 2), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function generateDocs(options = {}) {
    const base = String(options.publicBaseUrl || "https://your-domain.example").replace(/\/$/, "");
    const markdown = `# API Documentation: /embed-metadata & /strip - metadata

## Endpoints
        \`POST /embed-metadata\`
\`POST /strip-metadata\`

## Description
**embed-metadata**: Embeds realistic EXIF camera data into JPEG images alongside enriched XMP and IPTC metadata, making AI-generated images appear camera-captured from a metadata analysis perspective. Supported input formats: JPEG, PNG, WebP, GIF, BMP, TIFF. Output format is always JPEG.

**strip-metadata**: Removes all unnecessary metadata (EXIF, XMP, IPTC, COM) from the image to make it undetectable as AI-generated. Requires only \`image_path\`.

## Request Body (JSON)
| Field | Type | Required | Description | Default |
|---|---|---|---|---|
| \`image_path\` | string | Yes | Public URL OR Base64 string of the source image | |
| \`title\` | string | Yes | Image title / headline (max 200 chars) | |
| \`description\` | string | No | Caption / abstract (max 2000 chars) | |
| \`keywords\` | array | No | Array of strings (max 50 items) | \`[]\` |
| \`category\` | string | No | Category label | |
| \`creator\` | string | No | Author / byline | |
| \`copyright\` | string | No | Copyright notice | |
| \`camera_profile\` | string | No | Specific camera profile id (e.g. \`sony-a7iv-85\`, \`nikon-z8-35\`, \`canon-r5-50\`, \`fuji-xt5-23\`) | Random |
| \`software\` | string | No | Override the Software tag in EXIF | Camera profile default |
| \`location\` | object | No | Specific GPS location object (\`lat\`, \`lon\`, \`city\`, \`country\`) | Random from 20 world cities |

*Note: For \`/strip-metadata\`, only \`image_path\` is required. All other fields are ignored.*

## Authentication
Every API request requires an API key generated from the dashboard:
\`Authorization: Bearer YOUR_API_KEY\`
The admin key is only for the dashboard and must never be used in cURL requests.

## Example cURL Request
\`\`\`bash
curl -X POST ${base}/embed-metadata \\
-H "Content-Type: application/json" \\
-H "Authorization: Bearer YOUR_API_KEY" \\
-d '{
    "image_path": "https://tmpfiles.org/dl/1234/photo.jpg",
    "title": "A beautiful sunset",
    "description": "Sunset over the mountains.",
    "keywords": ["sunset", "mountains", "nature"],
    "category": "Nature",
    "creator": "Fuad Naser Bondhon",
    "copyright": "© 2026 Fuad Naser Bondhon",
    "camera_profile": "sony-a7iv-85",
    "software": "Adobe Lightroom Classic 13.4.1",
    "location": {
        "lat": 48.8566,
        "lon": 2.3522,
        "city": "Paris",
        "country": "France"
    }
}'
\`\`\`

## Response
Returns a JSON object containing the \`metadata_image_url\` (valid for 1 hour), file details, and applied \`exif_context\`.
`;
    return new Response(markdown, {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
}
