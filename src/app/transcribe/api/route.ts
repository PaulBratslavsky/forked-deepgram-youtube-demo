import { createClient } from "@supabase/supabase-js";
import { createClient as deepgramClient } from "@deepgram/sdk";

import { Features } from "@/context/transcription";
import { NextResponse } from "next/server";
import fs from "fs";
import urlParser from "@/util/urlParser";
import ytdl from "@distube/ytdl-core";

import featureMap from "@/util/featureMap";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""
);

  const dg = deepgramClient(process.env.DEEPGRAM_API_KEY as string);

const DOWNLOAD_TIMEOUT = 30000; // 30 seconds timeout

export async function POST(request: Request) {
  const body: {
    source: { url: string };
    features: Features;
  } = await request.json();
  const { source, features } = body;

  const videoId = urlParser(source.url);
  const mp3FilePath = `/tmp/ytdl-${videoId}.mp3`;
  const stream = fs.createWriteStream(mp3FilePath);

  const getVideo = new Promise((resolve, reject) => {
    const fetch = ytdl(`https://www.youtube.com/watch?v=${videoId}`, {
      filter: "audioonly",
      quality: "highestaudio",
    });
    
    const timeoutId = setTimeout(() => {
      stream.end();
      fetch.destroy();
      reject(new Error('Download timeout exceeded'));
    }, DOWNLOAD_TIMEOUT);
    
    fetch.on('error', (error) => {
      clearTimeout(timeoutId);
      stream.end();
      reject(new Error(`Download failed: ${error.message}`));
    });

    fetch.pipe(stream);
    
    stream.on('finish', async () => {
      clearTimeout(timeoutId);
      try {
        const map = featureMap(features.filter((f) => f.value !== false));
        const defaultFeatures = [
          { model: "nova-2" },
          { llm: 1 },
          { tag: "deeptube-demo" },
          { utt_split: 1.2 }
        ] as const;
        map.push(...defaultFeatures);

        const { result, error } = await dg.listen.prerecorded.transcribeFile(
          fs.createReadStream(mp3FilePath),
          {
            model: "nova-2",
            ...Object.fromEntries(map.map(item => Object.entries(item)[0]))
          }
        );
        
        if (error) throw new Error(error.message);

        const data = {
          source,
          features,
          ...result,
        };

        const { error: dbError } = await supabase.from("transcriptions").insert({
          url: source.url,
          request_id: result.metadata.request_id,
          data,
          features,
        });

        if (dbError) throw new Error(dbError.message);

        resolve({ request_id: result.metadata.request_id });
      } catch (error) {
        reject(error instanceof Error ? error.message : 'An unknown error occurred');
      } finally {
        fs.unlink(mp3FilePath, (err) => {
          if (err) console.error('Error cleaning up temporary file:', err);
        });
      }
    });
  });

  try {
    const result = await getVideo;
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'An unknown error occurred' },
      { status: 500 }
    );
  }
}
