
const getBrothers = async ()=>{
    const fetchPromise = fetch("https://thetatauzd.github.io/json/brothers.json");

fetchPromise
  .then((response) => response.json())
  .then((data) => {
    console.log(data);
  });
};


const showBrothers = async () =>{
    let brothers = await getBrothers();
    let brothersSection=document.getElementById("brothers-section");
    brothers.forEach((brother) => {
        brothersSection.append(getBrothers(brother));
    });
  
};

const getBrotherBio=(brother)=>{
    let section=document.createElement("section");

    let h3=document.createElement("h3");
    h3.innerText=brother.name;
    section.append(h3);

    let ul = document.createElement("ul");
    section.append(ul);
    ul.append(getLi(`Hometown: ${brother.hometown}`));
    ul.append(getLi(`Major(s): ${brother.majors}`));
    ul.append(getLi(`Minor(s): ${brother.minors}`));
    ul.append(getLi(`Bio: ${brother.bio}`));
    ul.append(getLi(`LinkedIn: ${brother.linkedIn}`));
    ul.append(getLi(`Resume: ${brother.resume}`));
    section.classList.add("brother");

    return section;
}


const getLi = data=>{
    const li =document.createElement("li");
    li.textContent= data;
    return li;
}


window.onload= ()=>{
    showBrothers();
}