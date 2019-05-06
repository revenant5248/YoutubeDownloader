# coding=utf-8
from bs4 import BeautifulSoup
import urllib
import urllib2
import codecs

def without_height(tag):
    return not tag.has_attr('height') #tag.has_attr('class') and
    
def for_latest_link(tag):
    return tag.has_attr('data-hot-link') and tag.has_attr('data-site-category-id') and tag.has_attr('data-article-link')#tag.has_attr('class') and


def Get989SongsAndSingers(url):
    response = urllib2.urlopen(url)#("")
    html = response.read()
    soup = BeautifulSoup(html,"html.parser")

    f2 = codecs.open("2.txt","a",encoding = "utf-8")

    #過濾title、歌手字串
    upper_is_songname_BOOL = None
    element_arr = ""
    for link in soup.find_all(without_height):
        if upper_is_songname_BOOL == True:#歌手名
            f2.write(link.contents[0]+"\n")
            upper_is_songname_BOOL = False
        else:
            try:
                u_class = link.get('class')[0]
                if u_class.find(u"xl63") == 0 and link.contents[0].find(u"Title") != 0: #xl63會是歌名或是Title(應該去除)，下一個則是歌手名。幹!這個是L不是1 
                    f2.write(link.contents[0]+" ")
                    upper_is_songname_BOOL = True
            except:
                upper_is_songname_BOOL = False
    f2.close()
    #raw_input("done")
    
    
def GetLatestLink(PageToGet_int):#此頁有20天內的歌單
    url = "http://bestradio.pixnet.net/blog/category/927232" 
    response = urllib2.urlopen(url)#("")
    html = response.read()
    soup = BeautifulSoup(html,"html.parser")
    
    day_link_arr = []
    c = 0
    for link in soup.find_all(for_latest_link):
        c+=1
        if c > PageToGet_int:
            break
        day_link_arr.append(link.get("data-article-link"))


    return day_link_arr
    
    
    
    
    
    
if __name__ == "__main__":   
    Url_arr = GetLatestLink(1)
    for url in Url_arr:
        Get989SongsAndSingers(url)
    #Get989SongsAndSingers("http://bestradio.pixnet.net/blog/post/66428016")